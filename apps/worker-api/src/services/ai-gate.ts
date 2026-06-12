// ══════════════════════════════════════════════════════════════
// services/ai-gate.ts
// دو مرحله جداگانه:
//   مرحله ۱ — Claude: فقط Scoring + Risk assessment
//   مرحله ۲ — Gemini یا OpenAI: Translation + Caption نوشتن
// ══════════════════════════════════════════════════════════════

import type { Env, NormalizedItem, AIGateResult, CategoryRow, ChannelRow } from '../types';
import { getPreAiContentRejectReason } from './content-policy';

// ── Provider configs ──────────────────────────────────────────

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VER = '2023-06-01';

const GEMINI_URL = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

type AIProvider = 'anthropic' | 'gemini' | 'openai' | 'claude';
type AIPurpose = 'scoring' | 'translation';

interface AIUsageRecord {
  provider: AIProvider;
  purpose: AIPurpose;
  model: string;
  inputTokens: number;
  outputTokens: number;
  status: 'success' | 'failed' | 'skipped';
  errorMessage?: string;
}

interface AIBudgetCheck {
  allowed: boolean;
  reason?: string;
  callsToday: number;
  tokensToday: number;
  maxCalls: number;
  tokenBudget: number;
}

// ── Prompt profiles (per category) ───────────────────────────

const PROMPT_PROFILES: Record<string, string> = {
  default_editorial:
    'Curate and rewrite for a general audience. Preserve facts, avoid speculation.',

  crypto_editorial:
    'Curate for a crypto/blockchain audience. Explain market, protocol, token, and risk context cautiously. ' +
    'NEVER provide financial advice. NEVER invent price predictions. ' +
    'Reject generic macro/economic-calendar posts unless the source text explicitly connects the event to crypto, Bitcoin, Ethereum, stablecoins, ETFs, DeFi, on-chain activity, liquidity, or digital-asset regulation. ' +
    'If a macro item is selected, the final rewrite must explain the crypto or digital-asset market relevance. ' +
    'Flag sponsored content, unverified claims, token promotions, and pump-and-dump signals. ' +
    'Be especially strict: reject any post that could amplify scams or market manipulation. ' +
    'Risk flags: pump_and_dump, financial_advice, unverified_claims, price_prediction, ' +
    'sponsored_content, regulatory_sensitive, scam_amplification, macro_without_crypto_angle.',

  design_editorial:
    'Curate for designers and product teams. Emphasize UX implications, visual patterns, tools, practical takeaways. ' +
    'Verify attribution of visual work. ' +
    'Risk flags: plagiarism, brand_misrepresentation, misleading_attribution, copyright_violation.',

  marketing_editorial:
    'Curate for marketing and growth teams. Emphasize strategy, channels, measurable outcomes. ' +
    'Reject posts with fake metrics or unverifiable case studies. ' +
    'Risk flags: exaggerated_claims, fake_case_study, misleading_metrics, astroturfing.',

  product_editorial:
    'Curate for product managers and founders. Emphasize user impact, adoption signals, roadmap implications. ' +
    'Risk flags: vaporware, misleading_roadmap, privacy_violation.',

  ai_news_editorial:
    'Curate for AI/ML practitioners. Emphasize model capabilities, safety, benchmarks. Avoid hype. ' +
    'Risk flags: capability_exaggeration, safety_downplay, hallucinated_benchmarks.',

  // ── NEW: Branding ──────────────────────────────────────────
  branding_editorial:
    'Curate for brand strategists, designers, and marketing professionals. ' +
    'Focus on brand identity, visual communication, brand campaigns, and brand strategy insights. ' +
    'Verify that claims about brands are attributed to official sources. ' +
    'Reject posts that misrepresent brand ownership, trademark, or campaign authorship. ' +
    'Do NOT republish copyrighted campaign creative without clear attribution. ' +
    'Reject unverified case studies or opinion presented as official brand news. ' +
    'Risk flags: brand_misrepresentation, trademark_misuse, misattributed_campaign, ' +
    'unverified_case_study, copyright_violation, opinion_as_fact.',

  // ── NEW: Finance ───────────────────────────────────────────
  finance_editorial:
    'Curate for finance professionals, investors, and informed general audience. ' +
    'Focus on macro trends, market analysis, regulatory changes, fintech innovation. ' +
    'NEVER provide investment advice. NEVER recommend specific securities or assets. ' +
    'ALWAYS note when content contains forward-looking statements. ' +
    'Reject posts with misleading financial metrics, outdated market data, or regulatory-sensitive wording. ' +
    'Require that market predictions are clearly labeled as opinion, not fact. ' +
    'Require that content referencing financial data cites a source. ' +
    'Risk flags: investment_advice, misleading_metrics, regulatory_sensitive, ' +
    'market_manipulation, missing_disclaimer, outdated_data, unverified_financial_claim.',
};

// ── Language names for translation prompts ────────────────────

const LANG_NAMES: Record<string, string> = {
  fa: 'Persian (Farsi)', en: 'English', ar: 'Arabic', tr: 'Turkish',
  ru: 'Russian', de: 'German', fr: 'French', es: 'Spanish',
  pt: 'Portuguese', zh: 'Chinese (Simplified)', hi: 'Hindi', id: 'Indonesian',
  ko: 'Korean', ja: 'Japanese', it: 'Italian', nl: 'Dutch',
};

// ══════════════════════════════════════════════════════════════
// Main entry point
// ══════════════════════════════════════════════════════════════

export async function runAIGate(
  env: Env,
  items: NormalizedItem[],
  category: CategoryRow,
  whitelistedAccounts: string[],
  channels: ChannelRow[] = []
): Promise<AIGateResult[]> {
  if (items.length === 0) return [];

  const cfg = loadConfig(env);
  cfg.languageTargets = JSON.parse(category.language_targets || '["fa"]');
  cfg.translationTargets = buildTranslationTargets(cfg.languageTargets, channels);

  if (cfg.dryRun) {
    return items.map(item => mockResult(item, category, cfg.translationTargets));
  }

  // ── مرحله ۱: Claude — Scoring + Risk ──────────────────────
  const scoreResults = await runScoring(env, cfg, items, category, whitelistedAccounts);

  const selectedForTranslation = items.filter((_, i) =>
    (scoreResults[i]?.publish ?? false) && (scoreResults[i]?.score ?? 0) >= category.score_threshold
  );

  if (selectedForTranslation.length === 0 || cfg.translationTargets.length === 0) {
    return scoreResults;
  }

  // ── مرحله ۲: Translation Provider ─────────────────────────
  const translationsMap = await runTranslation(env, cfg, selectedForTranslation, category);

  return scoreResults.map((result, i) => {
    const item = items[i]!;
    if (!result.publish) return result;
    const t = getTranslationsForItem(translationsMap, item);
    if (!t || Object.keys(t).length === 0) {
      // ترجمه موجود نیست — این یک خطای مشخص است نه رد ساکت
      console.warn(`[AIGate] No translation returned for item ${item.postId}`);
      return { ...result, publish: false, riskFlags: [...result.riskFlags, 'translation_missing'] };
    }
    // بررسی اینکه آیا همه targetهای لازم پوشش داده شدند
    const missingTargets = cfg.translationTargets.filter(target => !t[target.key]);
    if (missingTargets.length > 0) {
      console.warn(`[AIGate] Missing translations for targets: ${missingTargets.map(t => t.key).join(', ')} — item ${item.postId}`);
    }
    const missingFlags = missingTargets.map(target => `translation_missing:${target.key}`);
    return { ...result, riskFlags: [...result.riskFlags, ...missingFlags], translations: t };
  });
}

// ══════════════════════════════════════════════════════════════
// مرحله ۱ — Claude Scoring
// ══════════════════════════════════════════════════════════════

async function runScoring(
  env: Env,
  cfg: Config,
  items: NormalizedItem[],
  category: CategoryRow,
  whitelist: string[]
): Promise<AIGateResult[]> {
  // اگر custom_prompt در DB تنظیم شده، اولویت دارد (برای هر کتگوری دلخواه)
  const profile = category.custom_prompt?.trim() ||
    PROMPT_PROFILES[category.prompt_profile] ||
    PROMPT_PROFILES['default_editorial']!;
  const threshold = category.score_threshold;

  const budget = await checkScoringBudget(env, cfg);
  if (!budget.allowed) {
    console.warn(`[AIGate] Claude scoring skipped: ${budget.reason}`);
    await recordAIUsage(env, {
      provider: 'anthropic',
      purpose: 'scoring',
      model: cfg.scoringModel,
      inputTokens: 0,
      outputTokens: 0,
      status: 'skipped',
      errorMessage: budget.reason,
    });
    return items.map(item => ({
      publish: false,
      score: 0,
      riskLevel: 'medium' as const,
      riskFlags: ['ai_budget_exceeded'],
      topicFingerprint: `budget-${item.postId}`,
      publishPriority: 'normal' as const,
      translations: {},
    }));
  }

  const scoringEditorialPolicy = buildScoringEditorialPolicy(category);
  const strictCryptoScoringPolicy = isCryptoCategory(category)
    ? buildStrictCryptoScoringPolicy()
    : '';

  const system = [
    `You are an expert content curator. ${profile}`,
    scoringEditorialPolicy,
    strictCryptoScoringPolicy,
    '',
    `Score each item 0-100. Select items >= ${threshold}.`,
    '',
    'Return ONLY a JSON object with this exact structure (no markdown, no explanation):',
    '{"items":[{"url":"...","post_id":"...","publish":true,"score":85,"risk_level":"low","risk_flags":[],"topic_fingerprint":"short-slug","publish_priority":"normal"}]}',
    '',
    'publish_priority: "breaking"|"high"|"normal"|"low"',
    'risk_level: "low"|"medium"|"high" — set publish=false if high risk',
    'topic_fingerprint: story-level slug for deduplication, not a source-level or post-level slug.',
    'Make topic_fingerprint stable across sources, URLs, wording changes, translations, and minor numeric updates for the same underlying story within a 48-hour window.',
    'Use the same topic_fingerprint when multiple posts discuss the same event, regulation, exploit, launch, funding, market move, protocol upgrade, ETF flow, or institutional announcement.',
    'Only change topic_fingerprint when there is a materially new development, not just a different source repeating or slightly rephrasing the story.',
    'Good examples: "humanity-protocol-exploit", "us-clarity-act-legislation", "sbi-shinsei-crypto-deposit-rewards", "zcash-ironwood-upgrade", "undp-blockchain-advisory-group".',
    'Bad examples: source names, post IDs, generic slugs like "crypto-news", or separate fingerprints for the same story from different accounts.',
    'Use source metadata strictly: replies, retweets/reposts, quotes, and text-only posts should be scored according to the category policy below.',
    'Use engagement signals directionally, not blindly: likes, shares/retweets, and views can raise confidence for timely posts from reputable accounts, but never override risk flags, scam signals, missing context, or low editorial value.',
    'Do NOT include translations here.',
    'Return only the JSON object, nothing else.',
  ].join('\n');

  const inputItems = items.map(it => ({
    url: it.sourceUrl,
    post_id: it.postId,
    platform: it.platform,
    account: it.sourceAccount,
    in_whitelist: whitelist.includes(it.sourceAccount),
    published_at: new Date(it.publishedAt * 1000).toISOString(),
    text: it.text.slice(0, cfg.maxTextChars),
    likes: it.engagementLikes,
    shares: it.engagementShares,
    views: it.engagementViews,
    engagement_rate: engagementRate(it.engagementLikes, it.engagementShares, it.engagementViews),
    has_media: it.media.length > 0,
    media_count: it.media.length,
    is_reply: it.isReply === true,
    is_retweet: it.isRetweet === true,
    is_quote: it.isQuote === true,
  }));

  const user = [
    `Category: ${category.id} (${category.label})`,
    `Threshold: ${threshold}. Freshness: items older than ${category.freshness_hours}h should score lower.`,
    '',
    `Analyze these ${items.length} items:`,
    JSON.stringify(inputItems),
  ].join('\n');

  let lastErr = '';
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    if (attempt > 0) await sleep(2000 * attempt);
    try {
      const res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': ANTHROPIC_VER,
        },
        body: JSON.stringify({
          model: cfg.scoringModel,
          max_tokens: cfg.maxOutputTokens,
          system,
          messages: [{ role: 'user', content: user }],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) { lastErr = `Claude HTTP ${res.status}`; continue; }
      const body = await res.json() as any;
      const usage = extractAnthropicUsage(body);
      await recordAIUsage(env, {
        provider: 'anthropic',
        purpose: 'scoring',
        model: cfg.scoringModel,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        status: 'success',
      });
      const text: string = body.content?.[0]?.text ?? '';

      // Robust JSON extraction: try to find outermost JSON object
      const parsed = extractJsonObject(text);
      if (!parsed) { lastErr = 'No valid JSON in response'; continue; }
      if (!Array.isArray(parsed.items)) { lastErr = 'Missing items array in JSON'; continue; }
      return applyPostScoringHardGate(mapScoringResults(parsed.items, items), items, category);
    } catch (e) { lastErr = e instanceof Error ? e.message : String(e); }
  }

  console.error('[Scoring] All attempts failed:', lastErr);
  await recordAIUsage(env, {
    provider: 'anthropic',
    purpose: 'scoring',
    model: cfg.scoringModel,
    inputTokens: 0,
    outputTokens: 0,
    status: 'failed',
    errorMessage: lastErr,
  });
  return items.map(item => ({
    publish: false, score: 0, riskLevel: 'medium' as const,
    riskFlags: ['scoring_error'], topicFingerprint: `err-${item.postId}`,
    publishPriority: 'normal' as const, translations: {},
  }));
}

function isCryptoCategory(category: CategoryRow): boolean {
  return String(category.id ?? '').trim().toLowerCase() === 'crypto';
}

function buildStrictCryptoScoringPolicy(): string {
  return [
    'CRYPTO HARD GATE:',
    'Default to publish=false unless the source text itself contains an explicit crypto/digital-asset connection.',
    'Source account reputation is not enough. A post from SlowMist, DefiLlama, Decrypt, CoinDesk, or any crypto-native account can still be non-crypto.',
    'The text must directly mention at least one strong crypto anchor such as Bitcoin/BTC, Ethereum/ETH, Solana, stablecoin/USDT/USDC, DeFi, blockchain, on-chain, smart contract, wallet drain, crypto exchange, ETF tied to Bitcoin/Ethereum/crypto, tokenization/RWA, or named crypto venues/chains.',
    'Reject generic cybersecurity, software supply-chain, AI, macro, politics, stocks, SpaceX, sports, tech, legal, or business news unless the crypto connection is explicit in the source text.',
    'If you are unsure whether it is crypto, publish=false.',
    'If publish=false because crypto relevance is missing, include risk_flags containing "missing_explicit_crypto_relevance".',
  ].join('\n');
}

export function applyPostScoringHardGate(
  results: AIGateResult[],
  items: NormalizedItem[],
  category: CategoryRow,
): AIGateResult[] {
  if (!isCryptoCategory(category)) return results;

  return results.map((result, index) => {
    if (!result.publish) return result;

    const item = items[index];
    if (!item) return result;

    const hardRejectReason = getPreAiContentRejectReason(item, category);
    if (!hardRejectReason) return result;

    const flags = new Set(result.riskFlags ?? []);
    flags.add('hard_gate_after_ai');
    flags.add(hardRejectReason);
    flags.add('missing_explicit_crypto_relevance');

    return {
      ...result,
      publish: false,
      score: 0,
      riskLevel: result.riskLevel === 'high' ? result.riskLevel : 'medium',
      riskFlags: Array.from(flags).slice(0, 10),
      publishPriority: 'low',
    };
  });
}

// استخراج JSON از پاسخ AI — مقاوم در برابر markdown fences و متن اضافه
function extractJsonObject(text: string): { items: any[] } | null {
  // ابتدا markdown code blocks را حذف کن
  const cleaned = text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  // پیدا کن اولین { و آخرین } را
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;

  const candidate = cleaned.slice(firstBrace, lastBrace + 1);
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function mapScoringResults(parsed: any[], original: NormalizedItem[]): AIGateResult[] {
  const byUrl = new Map<string, any>();
  const byPostId = new Map<string, any>();

  for (const p of parsed) {
    if (typeof p.url === 'string') {
      for (const key of urlLookupKeys(p.url)) byUrl.set(key, p);
    }
    if (typeof p.post_id === 'string' && p.post_id.trim()) {
      byPostId.set(p.post_id.trim(), p);
    }
  }

  const validPriorities = ['breaking', 'high', 'normal', 'low'];

  return original.map(item => {
    const p = urlLookupKeys(item.sourceUrl).reduce<any>((found, key) => found ?? byUrl.get(key), undefined)
      ?? byPostId.get(item.postId);

    if (!p) {
      console.warn(`[Scoring] No result for URL/post_id: ${item.sourceUrl} / ${item.postId}`);
      return {
        publish: false, score: 0, riskLevel: 'medium' as const,
        riskFlags: ['not_scored'], topicFingerprint: `ns-${item.postId}`,
        publishPriority: 'normal' as const, translations: {},
      };
    }

    const score = clamp(Number(p.score) || 0, 0, 100);
    const riskLevel = (['low', 'medium', 'high'].includes(p.risk_level) ? p.risk_level : 'medium') as any;

    return {
      publish: p.publish === true && riskLevel !== 'high' && score > 0,
      score,
      riskLevel,
      riskFlags: Array.isArray(p.risk_flags)
        ? p.risk_flags.filter((f: any) => typeof f === 'string').slice(0, 10)
        : [],
      topicFingerprint: typeof p.topic_fingerprint === 'string'
        ? p.topic_fingerprint.slice(0, 100)
        : `fp-${item.postId}`,
      publishPriority: (validPriorities.includes(p.publish_priority) ? p.publish_priority : 'normal') as any,
      translations: {},
    };
  });
}

function urlLookupKeys(raw: string): string[] {
  const keys = new Set<string>();
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return [];
  keys.add(trimmed);
  keys.add(trimmed.replace(/\/$/, ''));

  try {
    const u = new URL(trimmed);
    u.hash = '';
    for (const key of Array.from(u.searchParams.keys())) {
      if (/^(utm_|fbclid$|gclid$|ref$|ref_src$|igshid$|mc_cid$|mc_eid$)/i.test(key)) {
        u.searchParams.delete(key);
      }
    }
    u.hostname = u.hostname.toLowerCase();
    const normalized = u.toString().replace(/\/$/, '');
    keys.add(normalized);
    keys.add(normalized.replace(/^https:\/\//, 'http://'));
    keys.add(normalized.replace(/^http:\/\//, 'https://'));
  } catch {
    // keep raw fallback keys only
  }

  return Array.from(keys);
}

function postIdLookupKey(raw: string): string {
  return `post_id:${String(raw ?? '').trim()}`;
}


type TranslationValue = { captionShort: string; captionFull: string; hashtags: string[] };

function isRtlLanguage(language: string): boolean {
  return language === 'fa' || language === 'ar';
}

function firstMeaningfulCaptionChar(text: string): string {
  for (const ch of Array.from(String(text ?? '').trim())) {
    if (!ch.trim()) continue;

    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0xfe0f || cp === 0x200c || cp === 0x200d) continue;
    if (cp >= 0x1f000 || (cp >= 0x2600 && cp <= 0x27bf)) continue;
    if (/^[\s"'“”‘’«»()[\]{}<>.,:;،؛.!?؟\-–—_+*=|\\/@#$]+$/u.test(ch)) continue;

    return ch;
  }

  return '';
}

export function hasValidRtlCaptionLead(text: string, language: string): boolean {
  if (!isRtlLanguage(language)) return true;

  const ch = firstMeaningfulCaptionChar(text);
  if (!ch) return true;

  return /\p{Script=Arabic}/u.test(ch);
}

function needsRtlLeadRepair(target: TranslationTarget, translation: TranslationValue): boolean {
  if (!isRtlLanguage(target.language)) return false;

  const shortBad = Boolean(translation.captionShort.trim()) && !hasValidRtlCaptionLead(translation.captionShort, target.language);
  const fullBad = Boolean(translation.captionFull.trim()) && !hasValidRtlCaptionLead(translation.captionFull, target.language);

  return shortBad || fullBad;
}

function extractLooseJsonObject(text: string): Record<string, any> | null {
  const cleaned = String(text ?? '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;

  try {
    const parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function buildRtlLeadRepairSystem(target: TranslationTarget): string {
  const languageName = LANG_NAMES[target.language] ?? target.language;

  return [
    `You repair Telegram captions for ${languageName}.`,
    'Return ONLY JSON with this exact structure: {"caption_short":"...","caption_full":"..."}',
    'Preserve the exact meaning, facts, names, numbers, entities, and tone.',
    'Do not add facts. Do not remove important details.',
    'Do not add a fixed or static prefix.',
    'Fix only the opening phrasing when needed so the caption starts cleanly for RTL.',
    'The first real word after any emoji/spacing MUST be in the target RTL language.',
    'The caption must never start with English, a Latin brand name, ticker, number, @handle, URL, hashtag, or punctuation-led English phrase.',
    target.language === 'fa'
      ? 'For Persian, if natural, you may use one formal relevant leading emoji from this set only: 📌 📊 ⚖️ 🏦 🔐 🚨 🔎. Do not force emoji.'
      : 'For Arabic, do not force emoji; use at most one formal relevant emoji only if natural.',
    'No markdown. No explanation.',
  ].join('\n');
}

function buildRtlLeadRepairUser(translation: TranslationValue): string {
  return JSON.stringify({
    caption_short: translation.captionShort,
    caption_full: translation.captionFull,
  });
}

async function callTranslationProviderForRepair(
  env: Env,
  cfg: Config,
  provider: Config['translationProvider'],
  system: string,
  user: string,
): Promise<string> {
  if (provider === 'gemini') return callGemini(env, cfg.translationModel, system, user);
  if (provider === 'openai') return callOpenAI(env, cfg.translationModel, system, user);
  return callClaude(env, cfg.translationModel || cfg.scoringModel, system, user);
}

async function repairRtlTranslationLeadIfNeeded(
  env: Env,
  cfg: Config,
  target: TranslationTarget,
  translation: TranslationValue,
  provider: Config['translationProvider'],
): Promise<TranslationValue | null> {
  if (!needsRtlLeadRepair(target, translation)) return translation;

  try {
    const responseText = await callTranslationProviderForRepair(
      env,
      cfg,
      provider,
      buildRtlLeadRepairSystem(target),
      buildRtlLeadRepairUser(translation),
    );

    const parsed = extractLooseJsonObject(responseText);
    if (!parsed) {
      console.warn(`[Translation] RTL lead repair returned invalid JSON for target=${target.key}. preview=${debugPreview(responseText)}`);
      return null;
    }

    const repaired: TranslationValue = {
      captionShort: typeof parsed.caption_short === 'string'
        ? parsed.caption_short.slice(0, target.captionShortMaxChars)
        : translation.captionShort,
      captionFull: typeof parsed.caption_full === 'string'
        ? parsed.caption_full.slice(0, target.captionMaxChars)
        : translation.captionFull,
      hashtags: translation.hashtags,
    };

    if (needsRtlLeadRepair(target, repaired)) {
      console.warn(`[Translation] RTL lead repair still invalid for target=${target.key}; translation omitted to avoid bad RTL publish.`);
      return null;
    }

    console.warn(`[Translation] RTL lead repaired for target=${target.key}`);
    return repaired;
  } catch (e) {
    console.warn(`[Translation] RTL lead repair failed for target=${target.key}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}


function engagementRate(likes: number, shares: number, views: number): number {
  const safeViews = Number.isFinite(views) && views > 0 ? views : 0;
  if (safeViews <= 0) return 0;
  const interactions = Math.max(0, Number(likes) || 0) + Math.max(0, Number(shares) || 0) * 2;
  return Math.round((interactions / safeViews) * 10000) / 10000;
}

function isDebugEnabled(env: Env): boolean {
  return env.LOG_LEVEL === 'debug' || (env as any).TRANSLATION_DEBUG_ENABLED === 'true';
}

function debugPreview(value: string, max = 1000): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}



function getTranslationsForItem(
  translationsMap: Map<string, Record<string, { captionShort: string; captionFull: string; hashtags: string[] }>>,
  item: NormalizedItem
): Record<string, { captionShort: string; captionFull: string; hashtags: string[] }> | undefined {
  const byPostId = translationsMap.get(postIdLookupKey(item.postId));
  if (byPostId) return byPostId;

  for (const key of urlLookupKeys(item.sourceUrl)) {
    const t = translationsMap.get(key);
    if (t) return t;
  }
  return undefined;
}

// ══════════════════════════════════════════════════════════════
// مرحله ۲ — Translation Provider (Gemini یا OpenAI)
// ══════════════════════════════════════════════════════════════

async function runTranslation(
  env: Env,
  cfg: Config,
  items: NormalizedItem[],
  category: CategoryRow
): Promise<Map<string, Record<string, { captionShort: string; captionFull: string; hashtags: string[] }>>> {
  const result = new Map<string, any>();
  if (items.length === 0) return result;

  const batchSize = clampInt(Number((env as any).TRANSLATION_BATCH_SIZE ?? 5), 1, 20);

  for (let offset = 0; offset < items.length; offset += batchSize) {
    const chunk = items.slice(offset, offset + batchSize);
    const chunkMap = await runTranslationChunk(env, cfg, chunk, category, offset);
    for (const [key, value] of chunkMap.entries()) result.set(key, value);
  }

  console.log(`[Translation] Completed chunks for ${items.length} item(s); mapped keys=${result.size}`);
  return result;
}

async function runTranslationChunk(
  env: Env,
  cfg: Config,
  items: NormalizedItem[],
  category: CategoryRow,
  offset: number
): Promise<Map<string, Record<string, { captionShort: string; captionFull: string; hashtags: string[] }>>> {
  const provider = cfg.translationProvider;
  const result = new Map<string, any>();

  const system = buildTranslationSystem(cfg.translationTargets, category);
  const user = buildTranslationUser(items, cfg.translationTargets, cfg.maxTextChars);

  let responseText = '';
  let lastErr = '';

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    if (attempt > 0) await sleep(2000 * attempt);
    try {
      if (provider === 'gemini') {
        responseText = await callGemini(env, cfg.translationModel, system, user);
      } else if (provider === 'openai') {
        responseText = await callOpenAI(env, cfg.translationModel, system, user);
      } else {
        responseText = await callClaude(env, cfg.translationModel || cfg.scoringModel, system, user);
      }
      if (responseText) break;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }

  if (!responseText) {
    console.error(`[Translation] Chunk offset=${offset} failed: ${lastErr}`);
    return result;
  }

  const parsed = extractJsonObject(responseText);
  if (!parsed || !Array.isArray(parsed.items)) {
    console.error(`[Translation] Could not parse JSON from chunk offset=${offset}. preview=${debugPreview(responseText)}`);
    return result;
  }

  let usable = 0;
  let mappedByPostId = 0;
  let mappedByUrl = 0;

  for (const p of parsed.items) {
    const postId = typeof p.post_id === 'string' ? p.post_id.trim() : '';
    const url = typeof p.url === 'string' ? p.url.trim() : '';

    if (!postId && !url) {
      console.warn(`[Translation] Parsed item missing both post_id and url at chunk offset=${offset}`);
      continue;
    }

    const translations: Record<string, any> = {};
    let missingCount = 0;

    for (const target of cfg.translationTargets) {
      const t = p.translations?.[target.key];
      if (t && (t.caption_short || t.caption_full)) {
        const translation: TranslationValue = {
          captionShort: String(t.caption_short ?? '').slice(0, target.captionShortMaxChars),
          captionFull: String(t.caption_full ?? '').slice(0, target.captionMaxChars),
          hashtags: Array.isArray(t.hashtags)
            ? t.hashtags.filter((h: any) => typeof h === 'string').slice(0, 10)
            : [],
        };

        const repaired = await repairRtlTranslationLeadIfNeeded(env, cfg, target, translation, provider);
        if (repaired) {
          translations[target.key] = repaired;
        } else {
          missingCount++;
        }
      } else {
        missingCount++;
      }
    }

    if (Object.keys(translations).length === 0) {
      console.warn(`[Translation] No usable translations for post_id=${postId || 'n/a'} url=${url || 'n/a'}`);
      continue;
    }

    usable++;

    if (missingCount > 0) {
      console.warn(`[Translation] ${missingCount}/${cfg.translationTargets.length} targets missing for post_id=${postId || 'n/a'} url=${url || 'n/a'}`);
    }

    if (postId) {
      result.set(postIdLookupKey(postId), translations);
      mappedByPostId++;
    }

    if (url) {
      for (const key of urlLookupKeys(url)) result.set(key, translations);
      mappedByUrl++;
    }
  }

  if (isDebugEnabled(env)) {
    console.log(`[Translation][debug] chunk offset=${offset} requested=${items.length} parsed=${parsed.items.length} usable=${usable} mappedByPostId=${mappedByPostId} mappedByUrl=${mappedByUrl} preview=${debugPreview(responseText)}`);
  } else {
    console.log(`[Translation] chunk offset=${offset} requested=${items.length} parsed=${parsed.items.length} usable=${usable} mappedByPostId=${mappedByPostId} mappedByUrl=${mappedByUrl}`);
  }

  if (items.length > 0 && parsed.items.length > 0 && usable === 0) {
    console.error(`[Translation] Parsed ${parsed.items.length} items but produced 0 usable translations at offset=${offset}`);
  }

  return result;
}

export interface TranslationTarget {
  key: string;
  language: string;
  label: string;
  toneProfile: string;
  customInstructions: string;
  channelId?: string;
  editorialMode: string;
  audienceLevel: string;
  captionStyle: string;
  creativityLevel: number;
  captionMaxChars: number;
  captionShortMaxChars: number;
  languagePrompt: string;
  terminologyNotes: string;
  forbiddenPhrases: string[];
}


function buildScoringEditorialPolicy(category: CategoryRow): string {
  const textOnlyPolicy = sanitizeTextOnlyPolicy(category.text_only_policy);
  const lines = [
    sanitizeInstruction(category.selection_criteria, 2000) ? `Selection criteria: ${sanitizeInstruction(category.selection_criteria, 2000)}` : '',
    sanitizeInstruction(category.rejection_criteria, 2000) ? `Rejection criteria: ${sanitizeInstruction(category.rejection_criteria, 2000)}` : '',
    sanitizeInstruction(category.required_context, 2000) ? `Standalone context requirement: ${sanitizeInstruction(category.required_context, 2000)}` : '',
    category.avoid_duplicate_people_stories !== 0
      ? 'Avoid selecting multiple near-duplicate posts about the same person/topic in the same run unless the later item adds clearly new information.'
      : '',
    intSetting(category.allow_replies, 0) === 0 ? 'Reply policy: reject or heavily down-rank replies unless they are independently understandable; deterministic pre-filter may reject replies before AI.' : 'Reply policy: replies may be considered if they are valuable and standalone.',
    intSetting(category.allow_retweets, 1) === 0 ? 'Retweet/repost policy: do not select retweets/reposts.' : 'Retweet/repost policy: retweets/reposts are allowed if editorially valuable.',
    intSetting(category.allow_quotes, 1) === 0 ? 'Quote policy: do not select quote posts unless category policy changes.' : 'Quote policy: quote posts are allowed if the quoted context is clear.',
    `Text-only policy: ${textOnlyPolicy}. ${textOnlyPolicy === 'penalize' ? 'Text-only posts need a stronger news/educational reason than posts with media.' : textOnlyPolicy === 'reject' ? 'Text-only posts are rejected before AI when media is expected.' : 'Text-only posts are allowed when valuable.'}`,
    category.min_score_for_text_only != null ? `Extra score floor for text-only items: ${category.min_score_for_text_only}.` : '',
    category.min_score_for_media != null ? `Extra score floor for media items: ${category.min_score_for_media}.` : '',
  ].filter(Boolean);
  return lines.length ? lines.join('\n') : '';
}

function intSetting(value: unknown, defaultValue: 0 | 1): 0 | 1 {
  return value === 0 || value === '0' || value === false ? 0 : value === 1 || value === '1' || value === true ? 1 : defaultValue;
}

function sanitizeTextOnlyPolicy(value: string | null | undefined): 'allow' | 'penalize' | 'reject' {
  const raw = String(value ?? 'allow').trim().toLowerCase();
  return raw === 'penalize' || raw === 'reject' ? raw : 'allow';
}

function sanitizeEditorialMode(value: string | null | undefined): string {
  const raw = String(value ?? 'news').trim().toLowerCase();
  return ['news', 'educational', 'analytical', 'brief', 'explainer'].includes(raw) ? raw : 'news';
}

function sanitizeAudienceLevel(value: string | null | undefined): string {
  const raw = String(value ?? 'intermediate').trim().toLowerCase();
  return ['beginner', 'intermediate', 'professional'].includes(raw) ? raw : 'intermediate';
}

function sanitizeCaptionStyle(value: string | null | undefined): string {
  const raw = String(value ?? 'contextual').trim().toLowerCase();
  return ['contextual', 'straight_news', 'educational_summary', 'insight_first'].includes(raw) ? raw : 'contextual';
}

function clampNumber(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseForbiddenPhrases(value: string | null | undefined): string[] {
  const raw = String(value ?? '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(x => String(x ?? '').trim()).filter(Boolean).slice(0, 30);
  } catch { /* comma/newline below */ }
  return raw.split(/[\n,]/).map(x => x.trim()).filter(Boolean).slice(0, 30);
}

function buildTranslationTargets(langs: string[], channels: ChannelRow[]): TranslationTarget[] {
  const targets: TranslationTarget[] = [];
  const seen = new Set<string>();

  for (const lang of langs) {
    if (!/^[a-z]{2}$/.test(lang) || seen.has(lang)) continue;
    targets.push({
      key: lang,
      language: lang,
      label: LANG_NAMES[lang] ?? lang,
      toneProfile: 'neutral',
      customInstructions: '',
      editorialMode: 'news',
      audienceLevel: 'intermediate',
      captionStyle: 'contextual',
      creativityLevel: 0.2,
      captionMaxChars: 1200,
      captionShortMaxChars: 280,
      languagePrompt: '',
      terminologyNotes: '',
      forbiddenPhrases: [],
    });
    seen.add(lang);
  }

  for (const ch of channels) {
    if (!ch.enabled) continue;
    const lang = ch.language;
    if (!langs.includes(lang)) continue;
    const tone = sanitizeToneProfile(ch.tone_profile);
    const custom = sanitizeInstruction(ch.custom_instructions);
    const label = sanitizeInstruction(ch.channel_label);
    const editorialMode = sanitizeEditorialMode(ch.editorial_mode);
    const audienceLevel = sanitizeAudienceLevel(ch.audience_level);
    const captionStyle = sanitizeCaptionStyle(ch.caption_style);
    const creativityLevel = clampNumber(Number(ch.creativity_level ?? 0.2), 0, 1);
    const captionMaxChars = clampInt(Number(ch.caption_max_chars ?? 1200), 280, 3500);
    const captionShortMaxChars = clampInt(Number(ch.caption_short_max_chars ?? 280), 80, 900);
    const languagePrompt = sanitizeInstruction(ch.language_prompt, 2000);
    const terminologyNotes = sanitizeInstruction(ch.terminology_notes, 2000);
    const forbiddenPhrases = parseForbiddenPhrases(ch.forbidden_phrases);
    const isChannelSpecific = Boolean(
      custom || label || tone !== 'neutral' ||
      editorialMode !== 'news' || audienceLevel !== 'intermediate' || captionStyle !== 'contextual' ||
      creativityLevel !== 0.2 || captionMaxChars !== 1200 || captionShortMaxChars !== 280 ||
      languagePrompt || terminologyNotes || forbiddenPhrases.length > 0
    );
    if (!isChannelSpecific) continue;

    const key = channelTranslationKey(ch.id);
    if (seen.has(key)) continue;
    targets.push({
      key,
      language: lang,
      label: label || ch.id,
      toneProfile: tone,
      customInstructions: custom,
      channelId: ch.id,
      editorialMode,
      audienceLevel,
      captionStyle,
      creativityLevel,
      captionMaxChars,
      captionShortMaxChars,
      languagePrompt,
      terminologyNotes,
      forbiddenPhrases,
    });
    seen.add(key);
  }

  return targets;
}

function channelTranslationKey(channelId: string): string {
  return `channel:${channelId}`;
}

function sanitizeToneProfile(value: string | null | undefined): string {
  const tone = String(value ?? 'neutral').trim().toLowerCase();
  return /^[a-z_ -]{1,40}$/.test(tone) ? tone : 'neutral';
}

function sanitizeInstruction(value: string | null | undefined, maxLen = 600): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export function buildTranslationSystem(targets: TranslationTarget[], category: CategoryRow): string {
  const targetLines = targets.map(t => {
    const parts = [
      `key=${JSON.stringify(t.key)}`,
      `language=${LANG_NAMES[t.language] ?? t.language}`,
      `tone=${t.toneProfile}`,
      `editorial_mode=${t.editorialMode}`,
      `audience_level=${t.audienceLevel}`,
      `caption_style=${t.captionStyle}`,
      `creativity=${t.creativityLevel.toFixed(2)}`,
      `caption_short_max_chars=${t.captionShortMaxChars}`,
      `caption_full_max_chars=${t.captionMaxChars}`,
    ];
    if (t.channelId) parts.push(`channel_id=${t.channelId}`);
    if (t.label) parts.push(`channel_label=${JSON.stringify(t.label)}`);
    if (t.customInstructions) parts.push(`instructions=${JSON.stringify(t.customInstructions)}`);
    if (t.languagePrompt) parts.push(`language_prompt=${JSON.stringify(t.languagePrompt)}`);
    if (t.terminologyNotes) parts.push(`terminology_notes=${JSON.stringify(t.terminologyNotes)}`);
    if (t.forbiddenPhrases.length) parts.push(`forbidden_phrases=${JSON.stringify(t.forbiddenPhrases)}`);
    return `- ${parts.join('; ')}`;
  }).join('\n');

  const exampleTranslations = targets.slice(0, Math.max(1, Math.min(2, targets.length)))
    .map(t => `"${t.key}":{"caption_short":"≤${t.captionShortMaxChars} chars","caption_full":"≤${t.captionMaxChars} chars","hashtags":[]}`)
    .join(',');

  const categoryNotes = [
    sanitizeInstruction(category.editorial_guidelines, 3000) ? `Category editorial guidelines: ${sanitizeInstruction(category.editorial_guidelines, 3000)}` : '',
    sanitizeInstruction(category.required_context, 2000) ? `Required context to add when useful: ${sanitizeInstruction(category.required_context, 2000)}` : '',
  ].filter(Boolean).join('\n');

  return [
    `You are an expert content curator and Telegram channel editor for category "${category.id}" (${category.label}).`,
    'For each item, write Telegram-ready posts for every translation target below.',
    'Rewrite for the target audience. Do not produce literal tweet translations.',
    'Make the post feel like a real channel post: news, educational, or analytical based on the target settings.',
    'When a person/entity is central and may not be obvious to a general audience, add concise context on first mention (e.g. role or why they matter).',
    categoryNotes,
    '',
    'Translation targets. The JSON translations object MUST use these exact keys:',
    targetLines,
    '',
    'Return ONLY a JSON object with this exact structure (no markdown, no explanation):',
    `{"items":[{"post_id":"...","url":"...","translations":{${exampleTranslations}}}]}`,
    '',
    'Strict rules:',
    '- caption_short: concise, engaging 1-2 sentence summary for media captions; respect each target max chars',
    '- caption_full: complete Telegram post with context; respect each target max chars',
    '- Persian (fa) captions must be in natural, fluent Farsi — NOT a literal translation',
    '- Persian (fa) caption_full and caption_short must start cleanly for RTL. Optional leading emoji is allowed, but the first real word after any emoji/spacing MUST be Persian.',
    '- Persian (fa) captions must never start with an English word, Latin brand name, ticker such as $BTC, number, @handle, URL, or hashtag.',
    '- Do not use a fixed or static prefix in Persian captions. Let the opening words be natural to the story while obeying the Persian-first rule.',
    '- Do not force emojis. For Persian (fa), when it suits the story tone, prefer one formal relevant leading emoji, but only if directly relevant and natural.',
    '- Approved Persian leading emoji examples: 📌 important note/news, 📊 markets/data, ⚖️ regulation, 🏦 banks/institutions, 🔐 security/hacks, 🚨 serious warning/alert, 🔎 analysis/review.',
    '- If an emoji is used, use only one; it must be formal, sparse, and directly relevant to the story; avoid meme, hype, cheap, repeated, or decorative emojis.',
    '- Arabic (ar) captions must be natural Arabic, not word-for-word translation',
    '- Avoid dry formulas like "X said in a new post" unless that framing is editorially necessary',
    '- Do NOT include source URLs or raw links. The publisher adds source attribution separately.',
    '- Do NOT include HTML tags — plain text only',
    '- Do NOT invent facts not present in the source text',
    '- Do NOT provide financial/investment advice',
    '- Remove source engagement bait and CTA questions such as "Which are you watching?", "What do you think?", "Which report matters most?", or equivalent phrasing in any language; replace with concise editorial context only when useful.',
    '- For crypto/blockchain items about macroeconomic data, explain the relevance to crypto or digital-asset markets; do not publish a generic economic calendar without that angle.',
    '- Respect forbidden_phrases for each target',
    '- hashtags: 3-5 relevant hashtags per target, no # prefix needed',
    '- Every translation target key listed above must be included for every item',
    'Return only the JSON object, nothing else.',
  ].filter(Boolean).join('\n');
}

function buildTranslationUser(items: NormalizedItem[], targets: TranslationTarget[], maxChars: number): string {
  const data = items.map(it => ({
    post_id: it.postId,
    url: it.sourceUrl,
    platform: it.platform,
    account: it.sourceAccount,
    text: it.text.slice(0, maxChars),
    has_media: it.media.length > 0,
    media_count: it.media.length,
    is_reply: it.isReply === true,
    is_retweet: it.isRetweet === true,
    is_quote: it.isQuote === true,
  }));

  return [
    `Translate and rewrite these ${items.length} items for these target keys: ${targets.map(t => t.key).join(', ')}`,
    'Remember: every item must include every requested target key in translations.',
    '',
    JSON.stringify(data),
  ].join('\n');
}

// ── Provider callers ──────────────────────────────────────────

async function callGemini(env: Env, model: string, system: string, user: string): Promise<string> {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const url = GEMINI_URL(model) + `?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: cfgMaxOutputTokens(env) },
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini ${res.status}: ${errText.slice(0, 200)}`);
  }

  const body = await res.json() as any;
  const usage = extractGeminiUsage(body);
  await recordAIUsage(env, {
    provider: 'gemini', purpose: 'translation', model,
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, status: 'success',
  });
  return body.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

async function callOpenAI(env: Env, model: string, system: string, user: string): Promise<string> {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: cfgMaxOutputTokens(env),
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI ${res.status}: ${errText.slice(0, 200)}`);
  }

  const body = await res.json() as any;
  const usage = extractOpenAIUsage(body);
  await recordAIUsage(env, {
    provider: 'openai', purpose: 'translation', model,
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, status: 'success',
  });
  return body.choices?.[0]?.message?.content ?? '';
}

async function callClaude(env: Env, model: string, system: string, user: string): Promise<string> {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VER,
    },
    body: JSON.stringify({
      model,
      max_tokens: cfgMaxOutputTokens(env),
      system,
      messages: [{ role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) throw new Error(`Claude HTTP ${res.status}`);
  const body = await res.json() as any;
  const usage = extractAnthropicUsage(body);
  await recordAIUsage(env, {
    provider: 'claude', purpose: 'translation', model,
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, status: 'success',
  });
  return body.content?.[0]?.text ?? '';
}

// ── Mock result (dry_run) ─────────────────────────────────────

function mockResult(item: NormalizedItem, category: CategoryRow, targets: TranslationTarget[]): AIGateResult {
  const translations: Record<string, any> = {};
  for (const target of targets) {
    translations[target.key] = {
      captionShort: `[DRY RUN ${target.key}] ${item.text.slice(0, 80)}`,
      captionFull: `[DRY RUN — ${category.id} — ${target.key}]\n${item.text.slice(0, 400)}`,
      hashtags: ['#dryrun'],
    };
  }
  return {
    publish: true, score: 78, riskLevel: 'low', riskFlags: [],
    topicFingerprint: `dryrun-${item.postId}`, publishPriority: 'normal', translations,
  };
}

// ══════════════════════════════════════════════════════════════
// Config
// ══════════════════════════════════════════════════════════════

interface Config {
  dryRun: boolean;
  scoringModel: string;
  translationProvider: 'gemini' | 'openai' | 'claude';
  translationModel: string;
  maxTextChars: number;
  maxRetries: number;
  maxOutputTokens: number;
  languageTargets: string[];
  translationTargets: TranslationTarget[];
}

function loadConfig(env: Env): Config {
  const provider = (env.TRANSLATION_PROVIDER || 'gemini').toLowerCase() as 'gemini' | 'openai' | 'claude';

  let defaultModel = 'gemini-2.5-flash-lite';
  if (provider === 'openai') defaultModel = 'gpt-4o-mini';
  if (provider === 'claude') defaultModel = env.AI_SCORING_MODEL || 'claude-haiku-4-5-20251001';

  return {
    dryRun: env.APIFY_CURATION_DRY_RUN === 'true',
    scoringModel: env.AI_SCORING_MODEL || 'claude-haiku-4-5-20251001',
    translationProvider: provider,
    translationModel: env.TRANSLATION_MODEL || defaultModel,
    maxTextChars: parseInt(env.AI_MAX_TEXT_CHARS_PER_ITEM || '400', 10),
    maxRetries: parseInt(env.AI_MAX_RETRIES || '1', 10),
    maxOutputTokens: parseInt(env.AI_MAX_OUTPUT_TOKENS || '4096', 10),
    languageTargets: [],
    translationTargets: [],
  };
}

// ── Helpers ───────────────────────────────────────────────────
async function checkScoringBudget(env: Env, cfg: Config): Promise<AIBudgetCheck> {
  const maxCalls = Math.max(0, parseInt(env.AI_MAX_CALLS_PER_DAY || '0', 10) || 0);
  const tokenBudget = Math.max(0, parseInt(env.AI_DAILY_TOKEN_BUDGET || '0', 10) || 0);
  const fallback: AIBudgetCheck = { allowed: true, callsToday: 0, tokensToday: 0, maxCalls, tokenBudget };

  if (!env.DB || (maxCalls === 0 && tokenBudget === 0)) return fallback;

  try {
    const row = await env.DB.prepare(`
      SELECT COUNT(*) as calls, COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
      FROM ai_usage
      WHERE provider='anthropic'
        AND purpose='scoring'
        AND status='success'
        AND created_at > datetime('now','-1 day')
    `).first<{ calls: number; tokens: number }>();

    const callsToday = Number(row?.calls ?? 0);
    const tokensToday = Number(row?.tokens ?? 0);
    if (maxCalls > 0 && callsToday >= maxCalls) {
      return { allowed: false, reason: `AI_MAX_CALLS_PER_DAY reached (${callsToday}/${maxCalls})`, callsToday, tokensToday, maxCalls, tokenBudget };
    }
    if (tokenBudget > 0 && tokensToday >= tokenBudget) {
      return { allowed: false, reason: `AI_DAILY_TOKEN_BUDGET reached (${tokensToday}/${tokenBudget})`, callsToday, tokensToday, maxCalls, tokenBudget };
    }
    return { allowed: true, callsToday, tokensToday, maxCalls, tokenBudget };
  } catch (e) {
    // Migration may not be applied yet. Do not take the whole curation system down because of telemetry.
    console.warn('[AIGate] Budget check skipped:', e instanceof Error ? e.message : String(e));
    return fallback;
  }
}

async function recordAIUsage(env: Env, usage: AIUsageRecord): Promise<void> {
  if (!env.DB) return;
  try {
    await env.DB.prepare(`
      INSERT INTO ai_usage (id, provider, purpose, model, input_tokens, output_tokens, status, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      `ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      usage.provider,
      usage.purpose,
      usage.model,
      Math.max(0, Math.floor(usage.inputTokens || 0)),
      Math.max(0, Math.floor(usage.outputTokens || 0)),
      usage.status,
      usage.errorMessage ? usage.errorMessage.slice(0, 400) : null,
    ).run();
  } catch (e) {
    console.warn('[AIGate] Failed to record AI usage:', e instanceof Error ? e.message : String(e));
  }
}

function extractAnthropicUsage(body: any): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: Number(body?.usage?.input_tokens ?? 0) || 0,
    outputTokens: Number(body?.usage?.output_tokens ?? 0) || 0,
  };
}

function extractGeminiUsage(body: any): { inputTokens: number; outputTokens: number } {
  const usage = body?.usageMetadata ?? {};
  return {
    inputTokens: Number(usage.promptTokenCount ?? 0) || 0,
    outputTokens: Number(usage.candidatesTokenCount ?? 0) || 0,
  };
}

function extractOpenAIUsage(body: any): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: Number(body?.usage?.prompt_tokens ?? 0) || 0,
    outputTokens: Number(body?.usage?.completion_tokens ?? 0) || 0,
  };
}

function cfgMaxOutputTokens(env: Env): number {
  return Math.max(256, Math.min(8192, parseInt(env.AI_MAX_OUTPUT_TOKENS || '4096', 10) || 4096));
}


function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
