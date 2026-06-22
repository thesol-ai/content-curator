// ══════════════════════════════════════════════════════════════
// services/ai-gate.ts
// دو مرحله جداگانه:
//   مرحله ۱ — Claude: فقط Scoring + Risk assessment
//   مرحله ۲ — Gemini یا OpenAI: Translation + Caption نوشتن
// ══════════════════════════════════════════════════════════════

import type { Env, NormalizedItem, AIGateResult, CategoryRow, ChannelRow } from '../types';
import { getPreAiContentRejectReason } from './content-policy';
import { getCategoryPolicy } from '../categories/registry';
import { applyPersianCaptionQualityGuard } from './story-quality-guard';
import {
  getAudienceProfileGuidance,
  isAudienceProfileScoringEnabled,
  primaryAudienceKey,
} from './audience-profile';
import { buildStoryKey, isStoryIntelligenceEnabled, parseStoryFields } from './story-intelligence';

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
    'Curate for Persian-speaking Iranian crypto readers, not generic U.S. retail investors. Prioritize items with practical relevance to Iranian readers: security/exploits, sanctions/regulation, stablecoins, exchange risk, ETF/institutional flows, major protocol incidents, liquidity, and Asia/MENA-relevant market structure. ' +
    'Explain market, protocol, token, and risk context cautiously. NEVER provide financial advice. NEVER invent price predictions. ' +
    'Reject generic macro/economic-calendar posts unless the source text explicitly connects the event to crypto, Bitcoin, Ethereum, stablecoins, ETFs, DeFi, on-chain activity, liquidity, or digital-asset regulation. ' +
    'Reject official project/exchange marketing, trading competitions, voucher campaigns, generic integrations, and tokenized-stock hype unless there is a concrete regulatory, security, liquidity, or market-structure reason Iranian crypto readers need it. ' +
    'If a macro or RWA/tokenized-equity item is selected, the final rewrite must explain why it matters to crypto users in Iran or Persian-speaking markets; otherwise reject it. ' +
    'Flag sponsored content, unverified claims, token promotions, and pump-and-dump signals. ' +
    'Be especially strict: reject any post that could amplify scams, thin liquidity, trading promotions, or market manipulation. ' +
    'Risk flags: pump_and_dump, financial_advice, unverified_claims, price_prediction, sponsored_content, regulatory_sensitive, scam_amplification, macro_without_crypto_angle, iran_audience_low_value, official_source_marketing.',

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

  const scoreResults = await scoreItems(env, items, category, whitelistedAccounts, channels);
  return attachTranslations(env, items, scoreResults, category, channels);
}

/**
 * Phase 6H — Stage 1 only: score + risk + topic fingerprint. Translations are
 * NOT produced here. Callers that want to run cheap deterministic gates
 * (dedupe/theme/audience) before paying for translation use this, then call
 * attachTranslations() for survivors only.
 */
export async function scoreItems(
  env: Env,
  items: NormalizedItem[],
  category: CategoryRow,
  whitelistedAccounts: string[],
  channels: ChannelRow[] = [],
  attributionItems?: AttributionItem[],
): Promise<AIGateResult[]> {
  if (items.length === 0) return [];

  const cfg = loadConfig(env);
  cfg.languageTargets = JSON.parse(category.language_targets || '["fa"]');
  cfg.translationTargets = buildTranslationTargets(cfg.languageTargets, channels);

  if (cfg.dryRun) {
    return items.map(item => mockResult(item, category, cfg.translationTargets));
  }

  return runScoring(env, cfg, items, category, whitelistedAccounts, attributionItems);
}

/**
 * Phase 6H — Stage 2: produce translations for the publish-eligible items that
 * do not already have them, and merge into the score results. Safe to call on
 * a partially-translated array; items that already carry translations (e.g.
 * dry-run mocks) are left untouched.
 */
export async function attachTranslations(
  env: Env,
  items: NormalizedItem[],
  scoreResults: AIGateResult[],
  category: CategoryRow,
  channels: ChannelRow[] = [],
  attributionItems?: AttributionItem[],
): Promise<AIGateResult[]> {
  if (items.length === 0) return scoreResults;

  const cfg = loadConfig(env);
  cfg.languageTargets = JSON.parse(category.language_targets || '["fa"]');
  cfg.translationTargets = buildTranslationTargets(cfg.languageTargets, channels);

  const needsTranslation = (i: number): boolean => {
    const r = scoreResults[i];
    if (!r || !r.publish) return false;
    if ((r.score ?? 0) < category.score_threshold) return false;
    return Object.keys(r.translations ?? {}).length === 0;
  };

  const selectedForTranslation = items.filter((_, i) => needsTranslation(i));

  if (selectedForTranslation.length === 0 || cfg.translationTargets.length === 0) {
    return scoreResults;
  }

  const attrByPostId = new Map<string, AttributionItem>(
    items.map((it, i) => [it.postId, attributionItems?.[i] ?? { sourceAccount: it.sourceAccount }] as const),
  );
  const translationsMap = await runTranslation(env, cfg, selectedForTranslation, category, attrByPostId);

  return scoreResults.map((result, i) => {
    const item = items[i]!;
    if (!result.publish) return result;
    if (!needsTranslation(i)) return result; // already had translations (e.g. mock)
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

const MUST_COVER_TICKER_RE =
  /\$?(?:USDT|USDC|BTC|ETH|BNB|SOL|DOGE|ADA|XRP|TRX|HYPE|TON)\b/u;

const MUST_COVER_NAME_RE =
  /\b(?:Bitcoin|Ethereum|Tether|USD Coin|Circle USD|BNB Chain|Solana|Dogecoin|Cardano|Ripple|XRP Ledger|Tron|TRON|Hyperliquid|Toncoin|Telegram Open Network|Gram)\b/iu;

export function hasMustCoverCryptoAsset(item: NormalizedItem): boolean {
  const text = [item.text, item.fullText, item.sourceUrl, item.postId]
    .map(v => String(v ?? ''))
    .join('\n');

  return MUST_COVER_TICKER_RE.test(text) || MUST_COVER_NAME_RE.test(text);
}

function hasUnsafeMustCoverRisk(result: AIGateResult): boolean {
  const flags = (result.riskFlags ?? []).join(' ').toLowerCase();

  return result.riskLevel === 'high'
    || /scam|pump|pump_and_dump|market_manipulation|financial_advice|sponsored_content|unverified_claims/.test(flags);
}

export function applyMustCoverCryptoAssetOverride(
  results: AIGateResult[],
  items: NormalizedItem[],
  category: CategoryRow,
): AIGateResult[] {
  if (!isCryptoCategory(category)) return results;

  return results.map((result, index) => {
    const item = items[index];
    if (!item || item.platform !== 'rss') return result;
    if (!hasMustCoverCryptoAsset(item)) return result;
    if (hasUnsafeMustCoverRisk(result)) return result;

    const flags = new Set(result.riskFlags ?? []);
    flags.add('must_cover_crypto_asset');

    return {
      ...result,
      publish: true,
      score: Math.max(result.score ?? 0, 75),
      riskLevel: result.riskLevel === 'high' ? 'medium' : result.riskLevel,
      riskFlags: Array.from(flags).slice(0, 10),
      publishPriority: result.publishPriority === 'low' ? 'normal' : result.publishPriority,
    };
  });
}

function itemScoringText(item: NormalizedItem, useExpandedRssText: boolean, maxTextChars: number): string {
  const baseMax = Number.isFinite(maxTextChars) && maxTextChars > 0 ? maxTextChars : 400;

  if (!useExpandedRssText || item.platform !== 'rss') {
    return String(item.text ?? '').slice(0, baseMax);
  }

  const rssMax = Math.max(baseMax, 1200);
  return [item.text, item.fullText]
    .map(v => String(v ?? '').trim())
    .filter(Boolean)
    .join('\n\n')
    .slice(0, rssMax);
}

async function runScoring(
  env: Env,
  cfg: Config,
  items: NormalizedItem[],
  category: CategoryRow,
  whitelist: string[],
  attributionItems?: AttributionItem[],
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
  const categoryScoringPolicy = getCategoryPolicy(category.id).buildScoringPolicy?.(category) ?? '';

  // Next phase (6J): optional audience-aware selection guidance. Flag-gated and
  // additive — it nudges relevance ranking for the channel's primary audience
  // (e.g. Persian/Iranian) without altering the numeric threshold.
  const audienceGuidance = isAudienceProfileScoringEnabled(env)
    ? (getAudienceProfileGuidance(primaryAudienceKey(cfg.languageTargets)) ?? '')
    : '';

  const isTrustedCryptoRssScoring = isCryptoCategory(category) && items.some(it => it.platform === 'rss');
  const trustedCryptoRssGuidance = isTrustedCryptoRssScoring
    ? [
        'Trusted RSS crypto news policy:',
        'For trusted RSS crypto news sources, default to publish=true for fresh, factual crypto news unless it is clearly duplicate, non-crypto, obvious marketing, scam-risk, pump-risk, or too minor.',
        'Do NOT require direct Iran-specific impact for trusted RSS news. Persian crypto readers follow global crypto markets.',
        'Iran/Persian-market relevance is a plus, not a requirement.',
        'Publish standard news about Bitcoin, Ethereum, major altcoins, ETFs, stablecoins, regulation, MiCA, SEC/CFTC/CME, exchange risk, exploits, bridge hacks, DeFi, RWA/tokenization, institutional treasury activity, mining, staking, crypto tax, macro events explicitly tied to BTC/crypto, and major token price moves.',
        'Do not reject BTC/ETH/XRP/SOL market analysis solely because it is price-related. Reject only if it is pure unsupported prediction, financial advice, pump language, or low-context chart noise.',
        'Use score 60-85 for normal publishable crypto news, 85+ for breaking or highly important news, and below 55 only for weak/minor items.',
        'Use publish=false only when the item is clearly not worth publishing, unsafe, duplicate, promotional, or unrelated to crypto.',
      ].join('\n')
    : '';

  const hasMustCoverAssetsInBatch = isCryptoCategory(category) && items.some(hasMustCoverCryptoAsset);
  const mustCoverCryptoAssetGuidance = hasMustCoverAssetsInBatch
    ? [
        'Must-cover crypto asset policy:',
        'The following assets are priority assets for the Persian/Iran crypto audience: USDT, USDC, BTC, ETH, BNB, SOL, DOGE, ADA, XRP, TRX, HYPE, TON, Gram.',
        'If an item is fresh factual RSS news about any must-cover asset, set publish=true unless it is clearly unsafe, scam/pump, duplicate, or unrelated.',
        'Do not reject must-cover asset news merely because it is market analysis, price movement, ETF/fund flow, regulation, stablecoin, exchange, security, DeFi, custody, institutional treasury, mining, staking, or macro news tied to crypto.',
        'For must-cover asset news, use score at least 75 for ordinary publishable news and higher for important/breaking news.',
      ].join('\n')
    : '';

  // Phase 6K (observe-only): when enabled, also ask for structured story fields.
  // Default off → JSON contract unchanged.
  const storyIntelEnabled = isStoryIntelligenceEnabled(env);
  const storyIntelInstr = storyIntelEnabled
    ? [
        'Additionally include structured story fields for clustering:',
        '"primary_entities": up to 3 canonical names central to the story (people/orgs/tokens/protocols), e.g. ["Tether","Monero","ZachXBT"].',
        '"event_type": a short slug for what happened, e.g. "security_laundering","etf_flows","listing","exploit","regulation","funding","protocol_upgrade".',
        '"canonical_date": the UTC date the event happened, "YYYY-MM-DD".',
      ].join('\n')
    : '';

  const system = [
    `You are an expert content curator. ${profile}`,
    scoringEditorialPolicy,
    categoryScoringPolicy,
    audienceGuidance,
    trustedCryptoRssGuidance,
    mustCoverCryptoAssetGuidance,
    storyIntelInstr,
    '',
    `Score each item 0-100. Select items >= ${threshold}.`,
    '',
    'Return ONLY a JSON object with this exact structure (no markdown, no explanation):',
    storyIntelEnabled
      ? '{"items":[{"url":"...","post_id":"...","publish":true,"score":85,"risk_level":"low","risk_flags":[],"topic_fingerprint":"short-slug","publish_priority":"normal","primary_entities":["Tether","Monero"],"event_type":"security_laundering","canonical_date":"2026-06-13"}]}'
      : '{"items":[{"url":"...","post_id":"...","publish":true,"score":85,"risk_level":"low","risk_flags":[],"topic_fingerprint":"short-slug","publish_priority":"normal"}]}',
    '',
    'publish_priority: "breaking"|"high"|"normal"|"low"',
    'risk_level: "low"|"medium"|"high" — set publish=false if high risk',
    'topic_fingerprint: story-level slug for deduplication, not a source-level or post-level slug.',
    'Make topic_fingerprint stable across sources, URLs, wording changes, translations, and minor numeric updates for the same underlying story within a 48-hour window.',
    'Use the same topic_fingerprint when multiple posts discuss the same event, regulation, exploit, launch, funding, market move, protocol upgrade, ETF flow, or institutional announcement.',
    'Only change topic_fingerprint when there is a materially new development, not just a different source repeating or slightly rephrasing the story.',
    'For recurring themes like USDT/XMR laundering, Metaplanet Bitcoin products, ETF daily flows, SpaceX/SPCX tokenized equity, tokenized CLO/RWA on Solana, use stable story-level fingerprints so downstream dedupe can block repeats.',
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
    must_cover_asset: hasMustCoverCryptoAsset(it),
    in_whitelist: whitelist.includes(it.sourceAccount),
    published_at: new Date(it.publishedAt * 1000).toISOString(),
    text: itemScoringText(it, isTrustedCryptoRssScoring, cfg.maxTextChars),
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
      const usageId = await recordAIUsage(env, {
        provider: 'anthropic',
        purpose: 'scoring',
        model: cfg.scoringModel,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        status: 'success',
      });
      await recordUsageAttribution(env, {
        categoryId: category.id, purpose: 'scoring', provider: 'anthropic', model: cfg.scoringModel,
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
        items: attributionItems ?? items.map(it => ({ sourceAccount: it.sourceAccount })),
        aiUsageId: usageId,
      });
      const text: string = body.content?.[0]?.text ?? '';

      // Robust JSON extraction: try to find outermost JSON object
      const parsed = extractJsonObject(text);
      if (!parsed) { lastErr = 'No valid JSON in response'; continue; }
      if (!Array.isArray(parsed.items)) { lastErr = 'Missing items array in JSON'; continue; }
      const mappedResults = mapScoringResults(parsed.items, items);
      const hardGatedResults = applyPostScoringHardGate(mappedResults, items, category);
      return applyMustCoverCryptoAssetOverride(hardGatedResults, items, category);
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

function statusIdFromUrl(raw: unknown): string | null {
  const m = /(?:status|statuses)\/(\d{6,25})/.exec(String(raw ?? ''));
  return m ? m[1]! : null;
}

function mapScoringResults(parsed: any[], original: NormalizedItem[]): AIGateResult[] {
  const byUrl = new Map<string, any>();
  const byPostId = new Map<string, any>();
  const byStatusId = new Map<string, any>(); // ROOT-CAUSE FIX: stable tweet-id fallback

  for (const p of parsed) {
    if (typeof p.url === 'string') {
      for (const key of urlLookupKeys(p.url)) byUrl.set(key, p);
      const sid = statusIdFromUrl(p.url);
      if (sid) byStatusId.set(sid, p);
    }
    if (typeof p.post_id === 'string' && p.post_id.trim()) {
      byPostId.set(p.post_id.trim(), p);
      const sid = statusIdFromUrl(p.post_id);
      if (sid) byStatusId.set(sid, p);
    }
  }

  const validPriorities = ['breaking', 'high', 'normal', 'low'];

  return original.map(item => {
    const itemSid = statusIdFromUrl(item.sourceUrl) ?? statusIdFromUrl(item.postId);
    const p = urlLookupKeys(item.sourceUrl).reduce<any>((found, key) => found ?? byUrl.get(key), undefined)
      ?? byPostId.get(item.postId)
      ?? (itemSid ? byStatusId.get(itemSid) : undefined); // ROOT-CAUSE FIX

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
      storyKey: buildStoryKey(parseStoryFields(p)),
      storyFields: parseStoryFields(p),
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

function shouldRetryPersianCaptionQuality(reason: string | undefined): boolean {
  return reason === 'caption_crypto_meta_or_audience_addressing'
    || reason === 'caption_vague_or_formal'
    || reason === 'caption_quality_low'
    || reason === 'caption_generic_filler';
}

function buildPersianCaptionStyleRepairSystem(): string {
  return [
    'You repair Persian Telegram crypto captions.',
    'Return ONLY JSON: {"caption_short":"...","caption_full":"..."}',
    'Keep the same facts, numbers, entities, and source-backed meaning.',
    'Do not add facts, advice, predictions, hype, or links.',
    'Rewrite as a normal crypto channel news post.',
    'Do NOT address the reader or audience.',
    'Banned Persian phrases and close variants: برای کاربران کریپتو، برای کاربران، نکته مهم این است، معنی ساده‌اش، به زبان ساده، این خبر از جنس، این خبر بیشتر درباره، اگر این مدل‌ها، نه فقط معامله، یکی از کاربردهای واقعی، یکی از کاربردهای جدی، فقط یک ایده حاشیه‌ای، نشان‌دهنده.',
    'Use concise, natural Iranian Persian. Start with a Persian word.',
  ].join('\n');
}

function buildPersianCaptionStyleRepairUser(translation: TranslationValue, sourceText: string): string {
  return JSON.stringify({
    source_text: sourceText,
    caption_short: translation.captionShort,
    caption_full: translation.captionFull,
  });
}

async function repairPersianCaptionStyleIfNeeded(
  env: Env,
  cfg: Config,
  translation: TranslationValue,
  sourceText: string,
  reason: string | undefined,
  provider: Config['translationProvider'],
): Promise<TranslationValue | null> {
  if (!shouldRetryPersianCaptionQuality(reason)) return null;

  try {
    const responseText = await callTranslationProviderForRepair(
      env,
      cfg,
      provider,
      buildPersianCaptionStyleRepairSystem(),
      buildPersianCaptionStyleRepairUser(translation, sourceText),
    );
    const parsed = extractLooseJsonObject(responseText);
    if (!parsed) return null;

    return {
      captionShort: typeof parsed.caption_short === 'string' ? parsed.caption_short : translation.captionShort,
      captionFull: typeof parsed.caption_full === 'string' ? parsed.caption_full : translation.captionFull,
      hashtags: translation.hashtags,
    };
  } catch (e) {
    console.warn(`[Translation] Persian caption style repair failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
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
  category: CategoryRow,
  attrByPostId?: Map<string, AttributionItem>,
): Promise<Map<string, Record<string, { captionShort: string; captionFull: string; hashtags: string[] }>>> {
  const result = new Map<string, any>();
  if (items.length === 0) return result;

  const batchSize = clampInt(Number((env as any).TRANSLATION_BATCH_SIZE ?? 5), 1, 20);

  for (let offset = 0; offset < items.length; offset += batchSize) {
    const chunk = items.slice(offset, offset + batchSize);
    const chunkMap = await runTranslationChunk(env, cfg, chunk, category, offset, attrByPostId);
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
  offset: number,
  attrByPostId?: Map<string, AttributionItem>,
): Promise<Map<string, Record<string, { captionShort: string; captionFull: string; hashtags: string[] }>>> {
  const provider = cfg.translationProvider;
  const result = new Map<string, any>();
  let chunkUsage: { inputTokens: number; outputTokens: number; usageId: string | null } = { inputTokens: 0, outputTokens: 0, usageId: null };
  const captureUsage = (u: { inputTokens: number; outputTokens: number; usageId: string | null }) => { chunkUsage = u; };

  const system = buildTranslationSystem(cfg.translationTargets, category);
  const user = buildTranslationUser(items, cfg.translationTargets, translationTextMaxChars(cfg, category));

  let responseText = '';
  let lastErr = '';

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    if (attempt > 0) await sleep(2000 * attempt);
    try {
      if (provider === 'gemini') {
        responseText = await callGemini(env, cfg.translationModel, system, user, captureUsage);
      } else if (provider === 'openai') {
        responseText = await callOpenAI(env, cfg.translationModel, system, user, captureUsage);
      } else {
        responseText = await callClaude(env, cfg.translationModel || cfg.scoringModel, system, user, captureUsage);
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

  // Phase-next: attribute this chunk's translation tokens across its items
  // (flag-gated; no-op when AI_COST_ATTRIBUTION_ENABLED is off).
  await recordUsageAttribution(env, {
    categoryId: category.id, purpose: 'translation', provider: cfg.translationProvider,
    model: cfg.translationModel, inputTokens: chunkUsage.inputTokens, outputTokens: chunkUsage.outputTokens,
    items: items.map(it => attrByPostId?.get(it.postId) ?? { sourceAccount: it.sourceAccount }),
    aiUsageId: chunkUsage.usageId,
  });

  let usable = 0;
  let mappedByPostId = 0;
  let mappedByUrl = 0;

  const originalByPostId = new Map(items.map(item => [item.postId, item] as const));
  const originalByUrl = new Map(items.map(item => [item.sourceUrl, item] as const));

  for (const p of parsed.items) {
    const postId = typeof p.post_id === 'string' ? p.post_id.trim() : '';
    const url = typeof p.url === 'string' ? p.url.trim() : '';

    if (!postId && !url) {
      console.warn(`[Translation] Parsed item missing both post_id and url at chunk offset=${offset}`);
      continue;
    }

    const translations: Record<string, any> = {};
    let missingCount = 0;
    const originalItem = (postId ? originalByPostId.get(postId) : undefined) ?? (url ? originalByUrl.get(url) : undefined);

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
        let qualityDecision: { ok: boolean; translation?: TranslationValue; reason?: string } = repaired
          ? applyPersianCaptionQualityGuard(target.language, repaired, originalItem?.text ?? '', {
              repairEnabled: String((env as any).CAPTION_QUALITY_REPAIR_ENABLED ?? '').toLowerCase() === 'true',
              rejectEnabled: String((env as any).CAPTION_QUALITY_REJECT_ENABLED ?? '').toLowerCase() === 'true',
              minScore: parseInt(String((env as any).CAPTION_QUALITY_MIN_SCORE ?? '70'), 10) || 70,
              categoryId: category.id,
            })
          : { ok: false, reason: 'rtl_repair_failed' };

        if (!qualityDecision.ok && target.language === 'fa' && repaired) {
          const styleRepaired = await repairPersianCaptionStyleIfNeeded(
            env,
            cfg,
            repaired,
            originalItem?.text ?? '',
            qualityDecision.reason,
            provider,
          );
          if (styleRepaired) {
            const rtlSafe = await repairRtlTranslationLeadIfNeeded(env, cfg, target, styleRepaired, provider);
            qualityDecision = rtlSafe
              ? applyPersianCaptionQualityGuard(target.language, rtlSafe, originalItem?.text ?? '', {
                  repairEnabled: String((env as any).CAPTION_QUALITY_REPAIR_ENABLED ?? '').toLowerCase() === 'true',
                  rejectEnabled: String((env as any).CAPTION_QUALITY_REJECT_ENABLED ?? '').toLowerCase() === 'true',
                  minScore: parseInt(String((env as any).CAPTION_QUALITY_MIN_SCORE ?? '70'), 10) || 70,
                  categoryId: category.id,
                })
              : { ok: false, reason: 'style_repair_rtl_failed' };
          }
        }

        if (qualityDecision.ok && qualityDecision.translation) {
          translations[target.key] = qualityDecision.translation;
        } else {
          console.warn(`[Translation] Caption quality guard omitted target=${target.key} reason=${qualityDecision.reason ?? 'unknown'} post_id=${postId || 'n/a'} url=${url || 'n/a'}`);
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

export function channelTranslationKey(channelId: string): string {
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

  const cryptoCaptionGuidance = isCryptoCategory(category) ? [
    'Crypto Persian caption writing mode:',
    '- Write for Persian-speaking crypto readers with mixed skill levels: beginners must understand it, professionals must not feel talked down to.',
    '- Use clear crypto language, not corporate/legal/research prose. The reader should understand the post on the first read.',
    '- Structure every Persian crypto caption as a normal Telegram news post: concrete fact first, then only source-backed context. Do NOT address the audience or explain that something is important “for users/readers”.',
    '- Explain crypto terms briefly when needed inside the sentence, not as a textbook aside. Examples: TVL = پولی که داخل پروتکل‌های دیفای قفل شده؛ ETF = صندوق قابل معامله در بورس؛ RWA = دارایی واقعی مثل طلا/سهام/اوراق که روی بلاکچین آمده؛ smart contract = قرارداد خودکار روی بلاکچین؛ liquidity = نقدینگی بازار؛ liquidation = بسته‌شدن اجباری معامله اهرمی.',
    '- Prefer short Telegram-native Persian: one concrete lead sentence, then one plain context sentence. caption_short should usually be 1-2 sentences; caption_full should usually be 2-4 short lines/paragraphs.',
    '- Lead with the concrete event, number, asset, protocol, institution, or risk. Do not begin with abstract framing or vague importance language.',
    '- Do not dress weakly crypto-adjacent stories as major crypto news. If the connection is weak, state the concrete connection briefly or keep the caption restrained.',
    '- Banned Persian caption style: do NOT use audience-addressing or meta-explainer phrases such as "برای کاربران کریپتو", "برای کاربران", "نکته مهم این است", "معنی ساده‌اش", "این خبر از جنس", "این خبر بیشتر درباره", "اگر این مدل‌ها", "نه فقط معامله", "نشان می‌دهد ... نیست". Write the news directly.',
    '- Good style examples: "پولی که داخل پروتکل‌های دیفای قفل شده، به زیر ۷۰ میلیارد دلار رسیده است. این یعنی سرمایه از دیفای خارج شده و بازار محتاط‌تر شده." / "مورفو ۱۷۵ میلیون دلار سرمایه جذب کرده و ارزشش به حدود ۲ میلیارد دلار رسیده است. حضور سرمایه‌گذارهای بزرگ یعنی دیفای هنوز برای پول نهادی جذاب است."',
  ] : [];

  return [
    `You are an expert content curator and Telegram channel editor for category "${category.id}" (${category.label}).`,
    'For each item, write Telegram-ready posts for every translation target below.',
    'Rewrite for the target audience. Do not produce literal tweet translations.',
    ...cryptoCaptionGuidance,
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
    '- Persian (fa) captions must be in natural, fluent Farsi for an Iranian crypto audience — NOT a literal translation and NOT generic U.S. retail/investor copy',
    '- Persian captions must read like a normal crypto channel post, not a lesson addressed to the reader. Do not write "برای کاربران..." or "نکته مهم..." lines. If there is no concrete source-backed context, stop after the facts.',
    '- Avoid generic filler such as "نشان‌دهنده پذیرش نهادی", "گامی مهم", "می‌تواند تأثیرگذار باشد" unless the source gives a concrete reason.',
    '- BANNED generic filler in Persian — do NOT use these or close variants: "نشان‌دهنده پذیرش", "نشان‌دهنده افزایش", "نشان‌دهنده تغییرات", "نشان‌دهنده بلوغ", "گامی در جهت", "می‌تواند تأثیرگذار باشد", "پتانسیل دموکراتیزه کردن", "یکی از بزرگترین رویدادهای تاریخ", "محسوب می‌شود". If you cannot give a concrete source-backed reason, omit the "why it matters" line entirely.',
    '- Every number, percentage, ticker, $ amount, date, and named entity in the caption MUST appear in the source text. Do NOT invent figures, valuations, IPO implications, or predictions absent from the source.',
    '- Bad (filler): "این خبر نشان‌دهنده پذیرش نهادی است و می‌تواند تأثیرگذار باشد." Good (concrete): "نوبیتکس در پی هک ۸۱.۷ میلیون دلار از دست داد؛ وجوه به آدرس‌های سوخت‌شده منتقل شد."',
    '- Prefer short, sharp, Telegram-native Persian: lead with the concrete fact, then at most one context line the source supports.',
    '- NO speculation: do NOT add hedging guesses such as "می‌تواند نشان‌دهنده ... باشد" / "ممکن است ... باشد" about why a transfer or move happened. For whale/transfer/on-chain-movement items, state ONLY the confirmed facts (amount, asset, from/to) and stop; do not guess motive or market impact unless the source states it.',
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
    '- Preserve dates and years exactly. If the source says 2026, the Persian caption must not say ۲۰۲۴ or ۲۰۲۵.',
    '- Do NOT provide financial/investment advice',
    '- Remove source engagement bait and CTA questions such as "Which are you watching?", "What do you think?", "Which report matters most?", or equivalent phrasing in any language; replace with concise editorial context only when useful.',
    '- For crypto/blockchain items about macroeconomic data, explain the relevance to crypto or digital-asset markets; do not publish a generic economic calendar without that angle.',
    '- Respect forbidden_phrases for each target',
    '- hashtags: 3-5 relevant hashtags per target, no # prefix needed',
    '- Every translation target key listed above must be included for every item',
    'Return only the JSON object, nothing else.',
  ].filter(Boolean).join('\n');
}

function translationTextMaxChars(cfg: Config, category: CategoryRow): number {
  // Crypto captions often need more than the cheap scoring slice. If the source
  // text is cut at 400 chars, the caption model tends to produce vague context.
  // Keep this crypto-only so other category-specific prompts stay untouched.
  return isCryptoCategory(category) ? Math.max(cfg.translationMaxTextChars, 1200) : cfg.translationMaxTextChars;
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

async function callGemini(env: Env, model: string, system: string, user: string, onUsage?: (u: { inputTokens: number; outputTokens: number; usageId: string | null }) => void): Promise<string> {
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
  const usageId = await recordAIUsage(env, {
    provider: 'gemini', purpose: 'translation', model,
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, status: 'success',
  });
  onUsage?.({ ...usage, usageId });
  return body.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

async function callOpenAI(env: Env, model: string, system: string, user: string, onUsage?: (u: { inputTokens: number; outputTokens: number; usageId: string | null }) => void): Promise<string> {
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
  const usageId = await recordAIUsage(env, {
    provider: 'openai', purpose: 'translation', model,
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, status: 'success',
  });
  onUsage?.({ ...usage, usageId });
  return body.choices?.[0]?.message?.content ?? '';
}

async function callClaude(env: Env, model: string, system: string, user: string, onUsage?: (u: { inputTokens: number; outputTokens: number; usageId: string | null }) => void): Promise<string> {
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
  const usageId = await recordAIUsage(env, {
    provider: 'claude', purpose: 'translation', model,
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, status: 'success',
  });
  onUsage?.({ ...usage, usageId });
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
  translationMaxTextChars: number;
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

  const scoringMaxTextChars = parseInt(env.AI_MAX_TEXT_CHARS_PER_ITEM || '400', 10);
  const translationMaxTextChars = clampInt(
    parseInt((env as any).AI_TRANSLATION_MAX_TEXT_CHARS || '', 10) || scoringMaxTextChars,
    scoringMaxTextChars,
    4000,
  );

  return {
    dryRun: env.APIFY_CURATION_DRY_RUN === 'true',
    scoringModel: env.AI_SCORING_MODEL || 'claude-haiku-4-5-20251001',
    translationProvider: provider,
    translationModel: env.TRANSLATION_MODEL || defaultModel,
    maxTextChars: scoringMaxTextChars,
    translationMaxTextChars,
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

async function recordAIUsage(env: Env, usage: AIUsageRecord): Promise<string | null> {
  if (!env.DB) return null;
  const usageId = `ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    await env.DB.prepare(`
      INSERT INTO ai_usage (id, provider, purpose, model, input_tokens, output_tokens, status, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      usageId,
      usage.provider,
      usage.purpose,
      usage.model,
      Math.max(0, Math.floor(usage.inputTokens || 0)),
      Math.max(0, Math.floor(usage.outputTokens || 0)),
      usage.status,
      usage.errorMessage ? usage.errorMessage.slice(0, 400) : null,
    ).run();
    return usageId;
  } catch (e) {
    console.warn('[AIGate] Failed to record AI usage:', e instanceof Error ? e.message : String(e));
    return null;
  }
}

function isCostAttributionEnabled(env: Env): boolean {
  return String((env as any).AI_COST_ATTRIBUTION_ENABLED ?? '').toLowerCase() === 'true';
}

export interface AttributionItem {
  sourceAccount: string;
  sourceId?: string | null;
  candidateId?: string | null;
  discoveryItemId?: string | null;
  channelId?: string | null;
}

/**
 * Phase-next cost attribution (flag-gated, default off, needs migration 0019).
 * Apportions a call's tokens equally across the items it covered and writes one
 * ai_usage_attribution row per item with FULL keys (source_id, candidate_id,
 * discovery_item_id, channel_id) when available. Best-effort; never throws.
 */
async function recordUsageAttribution(
  env: Env,
  args: {
    categoryId: string; purpose: AIPurpose; provider: string; model: string;
    inputTokens: number; outputTokens: number; items: AttributionItem[];
    aiUsageId?: string | null;
  },
): Promise<void> {
  if (!env.DB || !isCostAttributionEnabled(env)) return;
  const n = args.items.length;
  if (n === 0) return;
  const inEach = Math.floor((args.inputTokens || 0) / n);
  const outEach = Math.floor((args.outputTokens || 0) / n);
  try {
    for (const it of args.items) {
      await env.DB.prepare(`
        INSERT INTO ai_usage_attribution
          (id, ai_usage_id, category_id, channel_id, source_id, source_account,
           discovery_item_id, candidate_id, purpose, provider, model,
           input_tokens, output_tokens)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        `attr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        args.aiUsageId ?? null,
        args.categoryId,
        it.channelId ?? null,
        it.sourceId ?? null,
        String(it.sourceAccount ?? ''),
        it.discoveryItemId ?? null,
        it.candidateId ?? null,
        args.purpose, args.provider, args.model, inEach, outEach,
      ).run();
    }
  } catch (e) {
    console.warn('[AIGate] usage attribution skipped:', e instanceof Error ? e.message : String(e));
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
