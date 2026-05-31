// ══════════════════════════════════════════════════════════════
// services/ai-gate.ts
// دو مرحله جداگانه:
//   مرحله ۱ — Claude: فقط Scoring + Risk assessment
//   مرحله ۲ — Gemini یا OpenAI: Translation + Caption نوشتن
//
// چرا جدا؟
//   Translation حدود ۹۰٪ هزینه را می‌خورد (output token گران است).
//   Gemini Flash-Lite یا GPT-4o-mini برای ترجمه ۳× ارزان‌تر هستند.
//   Claude را فقط برای کار دقیق‌تر (scoring + risk) نگه می‌داریم.
// ══════════════════════════════════════════════════════════════

import type { Env, NormalizedItem, AIGateResult, CategoryRow } from '../types';

// ── Provider configs ──────────────────────────────────────────

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VER = '2023-06-01';

const GEMINI_URL = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

// ── Prompt profiles (per category) ───────────────────────────

const PROMPT_PROFILES: Record<string, string> = {
  default_editorial:
    'Curate and rewrite for a general audience. Preserve facts, avoid speculation.',

  crypto_editorial:
    'Curate for a crypto/blockchain audience. Explain market, protocol, token, and risk context cautiously. ' +
    'NEVER provide financial advice. NEVER invent price predictions. ' +
    'Risk flags: pump_and_dump, financial_advice, unverified_claims, price_prediction.',

  design_editorial:
    'Curate for designers and product teams. Emphasize UX implications, visual patterns, tools, practical takeaways. ' +
    'Risk flags: plagiarism, brand_misrepresentation, misleading_attribution.',

  marketing_editorial:
    'Curate for marketing and growth teams. Emphasize strategy, channels, measurable outcomes. ' +
    'Risk flags: exaggerated_claims, fake_case_study, misleading_metrics.',

  product_editorial:
    'Curate for product managers and founders. Emphasize user impact, adoption signals, roadmap implications. ' +
    'Risk flags: vaporware, misleading_roadmap, privacy_violation.',

  ai_news_editorial:
    'Curate for AI/ML practitioners. Emphasize model capabilities, safety, benchmarks. Avoid hype. ' +
    'Risk flags: capability_exaggeration, safety_downplay, hallucinated_benchmarks.',
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
  whitelistedAccounts: string[]
): Promise<AIGateResult[]> {
  if (items.length === 0) return [];

  const cfg = loadConfig(env);
  // languageTargets از category می‌آید
  cfg.languageTargets = JSON.parse(category.language_targets || '["fa"]');

  if (cfg.dryRun) {
    return items.map(item => mockResult(item, category, cfg.languageTargets));
  }

  // ── مرحله ۱: Claude — Scoring + Risk ──────────────────────
  const scoreResults = await runScoring(env, cfg, items, category, whitelistedAccounts);

  // فقط آیتم‌هایی که score بالا دارند به مرحله ترجمه می‌روند
  const selectedForTranslation = items.filter((_, i) =>
    (scoreResults[i]?.publish ?? false) && (scoreResults[i]?.score ?? 0) >= category.score_threshold
  );

  if (selectedForTranslation.length === 0 || cfg.languageTargets.length === 0) {
    return scoreResults;
  }

  // ── مرحله ۲: Translation Provider — فقط برای selected items ─
  const translationsMap = await runTranslation(env, cfg, selectedForTranslation, category);

  // ترکیب نتایج
  return scoreResults.map((result, i) => {
    const item = items[i]!;
    if (!result.publish) return result;
    const t = translationsMap.get(item.sourceUrl);
    return { ...result, translations: t ?? {} };
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
  const profile = PROMPT_PROFILES[category.prompt_profile] ?? PROMPT_PROFILES['default_editorial']!;
  const threshold = category.score_threshold;

  const system = [
    `You are an expert content curator. ${profile}`,
    '',
    `Score each item 0-100. Select items >= ${threshold}.`,
    '',
    'Return ONLY valid JSON (no markdown):',
    '{"items":[{"url":"...","publish":true,"score":85,"risk_level":"low","risk_flags":[],"topic_fingerprint":"slug","publish_priority":"normal"}]}',
    '',
    'publish_priority: "breaking"|"high"|"normal"|"low"',
    'risk_level: "low"|"medium"|"high" — set publish=false if high',
    'Do NOT include translations here.',
  ].join('\n');

  const inputItems = items.map(it => ({
    url: it.sourceUrl,
    platform: it.platform,
    account: it.sourceAccount,
    in_whitelist: whitelist.includes(it.sourceAccount),
    published_at: new Date(it.publishedAt * 1000).toISOString(),
    text: it.text.slice(0, cfg.maxTextChars),
    likes: it.engagementLikes,
    shares: it.engagementShares,
    has_media: it.media.length > 0,
  }));

  const user = [
    `Category: ${category.id} (${category.label})`,
    `Threshold: ${threshold}. Freshness: older than ${category.freshness_hours}h scores lower.`,
    '',
    `Analyze ${items.length} items:`,
    JSON.stringify(inputItems, null, 1),
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
          max_tokens: 2048,
          system,
          messages: [{ role: 'user', content: user }],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) { lastErr = `Claude ${res.status}`; continue; }
      const body = await res.json() as any;
      const text: string = body.content?.[0]?.text ?? '';
      const m = text.match(/\{[\s\S]*\}/);
      if (!m?.[0]) { lastErr = 'No JSON'; continue; }
      const parsed = JSON.parse(m[0]) as { items: any[] };
      if (!Array.isArray(parsed.items)) { lastErr = 'Bad structure'; continue; }
      return mapScoringResults(parsed.items, items);
    } catch (e) { lastErr = e instanceof Error ? e.message : String(e); }
  }

  console.error('[Scoring] Failed:', lastErr);
  // safe fallback: همه reject
  return items.map(item => ({
    publish: false, score: 0, riskLevel: 'medium' as const,
    riskFlags: ['scoring_error'], topicFingerprint: `err-${item.postId}`,
    publishPriority: 'normal' as const, translations: {},
  }));
}

function mapScoringResults(parsed: any[], original: NormalizedItem[]): AIGateResult[] {
  const byUrl = new Map<string, any>();
  for (const p of parsed) {
    if (typeof p.url === 'string') {
      byUrl.set(p.url.trim(), p);
      byUrl.set(p.url.trim().replace(/\/$/, ''), p);
    }
  }

  const validPriorities = ['breaking', 'high', 'normal', 'low'];

  return original.map(item => {
    const p = byUrl.get(item.sourceUrl) ?? byUrl.get(item.sourceUrl.replace(/\/$/, ''));
    if (!p) {
      return { publish: false, score: 0, riskLevel: 'medium' as const, riskFlags: ['not_scored'],
        topicFingerprint: `ns-${item.postId}`, publishPriority: 'normal' as const, translations: {} };
    }

    const score = clamp(Number(p.score) || 0, 0, 100);
    const riskLevel = (['low','medium','high'].includes(p.risk_level) ? p.risk_level : 'medium') as any;

    return {
      publish: p.publish === true && riskLevel !== 'high' && score > 0,
      score,
      riskLevel,
      riskFlags: Array.isArray(p.risk_flags) ? p.risk_flags.filter((f: any) => typeof f === 'string').slice(0, 10) : [],
      topicFingerprint: typeof p.topic_fingerprint === 'string' ? p.topic_fingerprint.slice(0, 100) : `fp-${item.postId}`,
      publishPriority: (validPriorities.includes(p.publish_priority) ? p.publish_priority : 'normal') as any,
      translations: {}, // پر می‌شود در مرحله ۲
    };
  });
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
  const provider = cfg.translationProvider; // 'gemini' | 'openai' | 'claude'
  const result = new Map<string, any>();

  if (items.length === 0) return result;

  const system = buildTranslationSystem(cfg.languageTargets, category.id);
  const user = buildTranslationUser(items, cfg.languageTargets, cfg.maxTextChars);

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
        // fallback به Claude
        responseText = await callClaude(env, cfg.translationModel || cfg.scoringModel, system, user);
      }
      break;
    } catch (e) { lastErr = e instanceof Error ? e.message : String(e); }
  }

  if (!responseText) {
    console.error('[Translation] Failed:', lastErr);
    return result;
  }

  // parse JSON از response
  const m = responseText.match(/\{[\s\S]*\}/);
  if (!m?.[0]) return result;

  try {
    const parsed = JSON.parse(m[0]) as { items: any[] };
    if (!Array.isArray(parsed.items)) return result;

    for (const p of parsed.items) {
      if (typeof p.url !== 'string') continue;
      const translations: Record<string, any> = {};
      for (const lang of cfg.languageTargets) {
        const t = p.translations?.[lang];
        if (t && (t.caption_short || t.caption_full)) {
          translations[lang] = {
            captionShort: String(t.caption_short ?? '').slice(0, 900),
            captionFull: String(t.caption_full ?? '').slice(0, 3500),
            hashtags: Array.isArray(t.hashtags) ? t.hashtags.filter((h: any) => typeof h === 'string').slice(0, 10) : [],
          };
        }
      }
      result.set(p.url.trim(), translations);
      result.set(p.url.trim().replace(/\/$/, ''), translations);
    }
  } catch { /* parse error, return empty */ }

  return result;
}

function buildTranslationSystem(langs: string[], categoryId: string): string {
  const langList = langs.map(l => `"${l}": ${LANG_NAMES[l] ?? l}`).join(', ');
  return [
    `You are an expert content curator and translator for category "${categoryId}".`,
    `For each item, write compelling Telegram posts in these languages: ${langList}.`,
    '',
    'Return ONLY valid JSON (no markdown):',
    '{"items":[{"url":"...","translations":{"fa":{"caption_short":"≤900 chars","caption_full":"≤3500 chars","hashtags":[]},"en":{"caption_short":"...","caption_full":"...","hashtags":[]}}}]}',
    '',
    'Rules:',
    '- caption_short: engaging summary for media caption, must be compelling',
    '- caption_full: complete post with source attribution at the end',
    '- Persian (fa) captions must be in natural, fluent Farsi',
    '- hashtags: 3-5 relevant hashtags per language',
    '- Do NOT invent facts not present in the source',
    '- Include source URL at the end of caption_full',
  ].join('\n');
}

function buildTranslationUser(items: NormalizedItem[], langs: string[], maxChars: number): string {
  const data = items.map(it => ({
    url: it.sourceUrl,
    platform: it.platform,
    account: it.sourceAccount,
    text: it.text.slice(0, maxChars),
    has_media: it.media.length > 0,
  }));

  return [
    `Translate and rewrite these ${items.length} items into: ${langs.join(', ')}`,
    '',
    JSON.stringify(data, null, 1),
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
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini ${res.status}: ${errText.slice(0, 200)}`);
  }

  const body = await res.json() as any;
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
      max_tokens: 4096,
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
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) throw new Error(`Claude ${res.status}`);
  const body = await res.json() as any;
  return body.content?.[0]?.text ?? '';
}

// ── Mock result (dry_run) ─────────────────────────────────────

function mockResult(item: NormalizedItem, category: CategoryRow, langs: string[]): AIGateResult {
  const translations: Record<string, any> = {};
  for (const lang of langs) {
    translations[lang] = {
      captionShort: `[DRY RUN ${lang}] ${item.text.slice(0, 80)}`,
      captionFull: `[DRY RUN — ${category.id} — ${lang}]\n${item.text.slice(0, 400)}\n\nمنبع: ${item.sourceUrl}`,
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
  languageTargets: string[];
}

function loadConfig(env: Env): Config {
  const provider = (env.TRANSLATION_PROVIDER || 'gemini').toLowerCase() as 'gemini' | 'openai' | 'claude';

  // مدل پیش‌فرض بر اساس provider
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
    languageTargets: [], // از category.language_targets پر می‌شود در runAIGate
  };
}


// ── Helpers ───────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
