// ── RSS Persian brief generation (copyright-safe rewrite) ──────
//
// For RSS survivors we do NOT translate the article line-by-line (copyright).
// We ask Claude for an original Persian analytical brief and then enforce a
// post-check guardrail: bounded length and no long verbatim run from the source.

import type { AIGateResult, CategoryRow, ChannelRow, Env, NormalizedItem, TranslationOutput } from '../types';
import { channelTranslationKey } from './ai-gate';
import { extractFullTextForBrief, getRssExtractorConfig } from './rss-content-extractor';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VER = '2023-06-01';

const CAPTION_FULL_MAX = 900;
const CAPTION_SHORT_MAX = 180;
const RSS_BRIEF_SOURCE_MAX_CHARS = 3000;

const BAD_RSS_BRIEF_PHRASES = [
  'کاسپ',
  'اختیار‌دهی',
  'اختیارد‌هی',
  'به‌عهده‌دهند',
  'به عهده دهند',
  'رانندگی‌های ارائه‌دهنده',
  'رانندگی ارائه‌دهنده',
  'تابعیت کاسپ',
  'نشان‌دهندهٔ',
  'نشان‌دهنده',
];

type RssBriefProvider = 'anthropic' | 'gemini';

interface RssBriefConfig {
  provider: RssBriefProvider;
  model: string;
  maxCallsPerDay: number;
  timeoutMs: number;
}

function normalizeRssBriefProvider(env: Env): RssBriefProvider {
  const explicit = String((env as any).RSS_BRIEF_PROVIDER ?? '').trim().toLowerCase();
  if (explicit === 'gemini') return 'gemini';
  if (explicit === 'anthropic' || explicit === 'claude') return 'anthropic';

  const claudeScoringDisabled = String((env as any).CLAUDE_SCORING_DISABLED ?? '').toLowerCase() === 'true';
  if (claudeScoringDisabled) {
    const translationProvider = String((env as any).TRANSLATION_PROVIDER ?? 'gemini').trim().toLowerCase();
    if (translationProvider === 'gemini') return 'gemini';
  }

  return 'anthropic';
}

function getRssBriefConfig(env: Env): RssBriefConfig {
  const n = (v: string | undefined, d: number) => {
    const x = Math.floor(Number(v));
    return Number.isFinite(x) ? x : d;
  };

  const provider = normalizeRssBriefProvider(env);
  const model = String(
    (env as any).RSS_BRIEF_MODEL
      || (provider === 'gemini'
        ? ((env as any).TRANSLATION_MODEL || 'gemini-2.5-flash-lite')
        : ((env as any).DUPLICATE_AI_JUDGE_MODEL || (env as any).AI_SCORING_MODEL || 'claude-haiku-4-5-20251001'))
  );

  return {
    provider,
    model,
    maxCallsPerDay: Math.max(0, n((env as any).RSS_BRIEF_MAX_CALLS_PER_DAY, 20)),
    timeoutMs: Math.max(5000, n((env as any).RSS_BRIEF_TIMEOUT_SEC, 25) * 1000),
  };
}

async function countBriefCallsToday(env: Env, cfg: RssBriefConfig): Promise<number> {
  if (!env.DB) return 0;
  try {
    // Count only real calls for the active RSS brief provider/model. Claude outage
    // history must not block Gemini fallback tests, and vice versa. Daily-cap
    // "skipped" entries record no API call and are intentionally excluded.
    const row = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM ai_usage
      WHERE provider = ?
        AND purpose = 'rss_brief'
        AND model = ?
        AND status IN ('success','failed')
        AND created_at > datetime('now','-1 day')
    `).bind(cfg.provider, cfg.model).first<{ count: number }>();
    return Number(row?.count ?? 0);
  } catch {
    return 0;
  }
}

export interface RssBriefBudgetState {
  /** No daily cap configured (maxCallsPerDay <= 0). */
  unlimited: boolean;
  /** No brief calls left today. */
  exhausted: boolean;
  callsToday: number;
  maxCallsPerDay: number;
  /** Brief calls left today; Infinity when unlimited. */
  remaining: number;
}

/**
 * Snapshot of the RSS brief daily budget. The drain calls this BEFORE
 * claiming/scoring so that (a) when exhausted, RSS is excluded up front and never
 * consumes AI scoring / duplicate-judge budget just to be deferred at the brief
 * step (cross-tick cost churn); and (b) when only partly spent, no more RSS than
 * `remaining` is claimed per run (the surplus would be scored only to be
 * cap-deferred). maxCallsPerDay <= 0 means "no cap" (unlimited).
 */
export async function getRssBriefBudgetState(env: Env): Promise<RssBriefBudgetState> {
  const cfg = getRssBriefConfig(env);
  if (cfg.maxCallsPerDay <= 0) {
    return { unlimited: true, exhausted: false, callsToday: 0, maxCallsPerDay: 0, remaining: Infinity };
  }
  const callsToday = await countBriefCallsToday(env, cfg);
  const remaining = Math.max(0, cfg.maxCallsPerDay - callsToday);
  return { unlimited: false, exhausted: remaining <= 0, callsToday, maxCallsPerDay: cfg.maxCallsPerDay, remaining };
}

function normalizeWords(s: string): string[] {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * True if `brief` reproduces a run of >= minRunWords consecutive words verbatim
 * from `source`. Used to catch line-by-line copying that the prompt forbade.
 */
export function hasLongVerbatimOverlap(brief: string, source: string, minRunWords = 12): boolean {
  const b = normalizeWords(brief);
  const src = normalizeWords(source);
  if (b.length < minRunWords || src.length < minRunWords) return false;

  const srcRuns = new Set<string>();
  for (let i = 0; i + minRunWords <= src.length; i++) {
    srcRuns.add(src.slice(i, i + minRunWords).join(' '));
  }
  for (let i = 0; i + minRunWords <= b.length; i++) {
    if (srcRuns.has(b.slice(i, i + minRunWords).join(' '))) return true;
  }
  return false;
}

export function clampCaption(text: unknown, max: number): string {
  const t = String(text ?? '').replace(/\s+\n/g, '\n').trim();
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/\s+\S*$/, '').trim();
}


function briefTitleKey(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[.。؟?!،؛:：]+/gu, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function repairRepeatedTitleSegments(text: string): string {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return clean;

  const parts = clean.split(/\s*[:：]\s*/u);
  if (parts.length < 3) return clean;

  const out: string[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;

    const prev = out[out.length - 1] ?? '';
    const prevKey = briefTitleKey(prev);
    const partKey = briefTitleKey(part);

    if (partKey && prevKey.endsWith(partKey)) continue;
    out.push(part);
  }

  return out.join(': ');
}

function briefTitleWithPeriod(text: string): string {
  const clean = repairRepeatedTitleSegments(text)
    .replace(/[.。؟?!،؛:：]+$/u, '')
    .trim();

  return clean ? `${clean}.` : clean;
}

function ensureCaptionFullLeadTitle(captionShort: string, captionFull: string): string {
  const title = briefTitleWithPeriod(captionShort);
  const body = String(captionFull ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!title) return body;
  if (!body) return title;

  const lines = body.split(/\n+/u);
  const firstLine = briefTitleWithPeriod(lines[0] ?? '');
  const firstKey = briefTitleKey(firstLine);
  const titleKey = briefTitleKey(title);

  if (firstKey && (firstKey === titleKey || firstKey.includes(titleKey) || titleKey.includes(firstKey))) {
    return [title, ...lines.slice(1)].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  return `${title}\n\n${body}`;
}

/** Append deterministic source attribution so it never depends on the model. */
export function withAttribution(captionFull: string, label: string, url: string): string {
  const line = `\n\n🔗 منبع: ${label} — ${url}`;
  const room = CAPTION_FULL_MAX - line.length;
  return clampCaption(captionFull, Math.max(0, room)) + line;
}

export interface BriefDraft {
  captionShort: string;
  captionFull: string;
  hashtags: string[];
}

/**
 * Validate + repair a raw brief against the copyright/length guardrail.
 * Returns null when the draft is unusable (caller releases the item to retry).
 */
export function sanitizeBrief(
  draft: { captionShort?: unknown; captionFull?: unknown; hashtags?: unknown },
  sourceText: string,
): BriefDraft | null {
  const rawCaptionFull = clampCaption(draft.captionFull, CAPTION_FULL_MAX);
  if (rawCaptionFull.length < 60) return null;

  const captionShort = repairRepeatedTitleSegments(
    clampCaption(draft.captionShort || rawCaptionFull.split('
')[0] || rawCaptionFull, CAPTION_SHORT_MAX)
  );
  if (captionShort.length < 12) return null;
  if (hasBadRssBriefStyle(captionShort)) return null;

  const captionFull = clampCaption(
    ensureCaptionFullLeadTitle(captionShort, rawCaptionFull),
    CAPTION_FULL_MAX,
  );

  if (captionFull.length < 60) return null;
  if (hasLongVerbatimOverlap(captionFull, sourceText)) return null;
  if (hasBadRssBriefStyle(captionFull)) return null;

  const hashtags = Array.isArray(draft.hashtags)
    ? draft.hashtags.map(h => String(h).replace(/^#/, '').trim()).filter(Boolean).slice(0, 5)
    : [];

  return { captionShort, captionFull, hashtags };
}


function firstMeaningfulPersianCaptionChar(text: string): string {
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

function hasValidPersianRtlLead(text: string): boolean {
  const ch = firstMeaningfulPersianCaptionChar(text);
  if (!ch) return true;
  return /\p{Script=Arabic}/u.test(ch);
}

function hasBadRssBriefStyle(text: string): boolean {
  const t = String(text ?? '').trim();
  if (!t) return true;
  if (!hasValidPersianRtlLead(t)) return true;

  // RSS posts must look like the normal Telegram caption style, not a legal memo
  // pretending to be a crypto post.
  if (/(^|\n)\s*[•*-]\s+/u.test(t)) return true;
  if (/https?:\/\//i.test(t)) return true;
  if (/\b(source|منبع)\b\s*[:：-]/iu.test(t)) return true;

  const normalized = t.replace(/\s+/g, ' ');
  return BAD_RSS_BRIEF_PHRASES.some(phrase => normalized.includes(phrase));
}

function buildBriefSystem(): string {
  return [
    'You write short Persian Telegram crypto posts from English RSS news articles.',
    'You are NOT translating line by line. You rewrite the article into one clear channel post.',
    '',
    'Hard rules:',
    '- Use only facts present in the source article.',
    '- Do not add predictions, investment advice, hype, or unsupported market impact.',
    '- Do not quote the article. Do not preserve its sentence order.',
    '- Do not include source URLs, source labels, signatures, channel IDs, @handles, or footer text. The publisher adds those later.',
    '- Do not use bullet lists, numbered lists, markdown, HTML, or hashtags inside captionFull.',
    '- Do not write legal/corporate Persian. Use clear Iranian Persian that a normal crypto reader understands on first read.',
    '- Avoid awkward literal terms. Examples: write «ارائه‌دهنده خدمات رمزارزی» instead of CASP jargon; write «قرارداد دائمی» for perpetual; explain dense terms briefly if needed.',
    '- Banned Persian wording: کاسپ، اختیار‌دهی، به‌عهده‌دهند، رانندگی‌های ارائه‌دهنده، نشان‌دهندهٔ، نشان‌دهنده.',
    '',
    'Persian RTL + emoji rules:',
    '- captionShort and captionFull must start cleanly for Persian Telegram rendering.',
    '- Optional leading emoji is allowed only if formal and directly relevant; do not force emoji.',
    '- If an emoji is used, use exactly one formal emoji from this set only: 📌 📊 ⚖️ 🏦 🔐 🚨 🔎.',
    '- The first real word after any emoji/spacing MUST be Persian.',
    '- Never start captionShort or captionFull with an English word, Latin brand name, ticker, number, @handle, URL, hashtag, or punctuation-led English phrase.',
    '- Do not use a fixed/static Persian prefix. Rewrite naturally. Example: use «صندوق UBS ...» not «UBS ...».',
    '',
    'Required format:',
    '- captionShort: a clean Persian title, 45–110 chars.',
    '- captionFull: first line must be the same title or a close title and MUST end with a period/full stop. Then one blank line. Then 1–2 short Persian paragraphs. Total under ~750 chars.',
    '- Do not add HTML or markdown for the title. The Telegram formatter will render the first line as bold.',
    '- The caption must feel like the existing X/Twitter Telegram posts: short, direct, useful, readable.',
    '- hashtags: 3–5 relevant tags WITHOUT # prefix.',
    '',
    'Return ONLY JSON: {"captionShort":"...","captionFull":"...","hashtags":["..."]}',
  ].join('\n');
}

function extractJson(text: string): any | null {
  const cleaned = String(text ?? '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try { return JSON.parse(cleaned.slice(first, last + 1)); } catch { return null; }
}

async function recordBriefUsage(env: Env, provider: RssBriefProvider, model: string, inT: number, outT: number, status: string, note?: string): Promise<void> {
  if (!env.DB) return;
  try {
    const id = `rss_brief_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await env.DB.prepare(`
      INSERT INTO ai_usage (id, provider, purpose, model, input_tokens, output_tokens, status, error_message)
      VALUES (?, ?, 'rss_brief', ?, ?, ?, ?, ?)
    `).bind(id, provider, model, Math.max(0, inT), Math.max(0, outT), status, note ?? null).run();
  } catch { /* best-effort */ }
}

function extractGeminiBriefUsage(body: any): { inputTokens: number; outputTokens: number } {
  const u = body?.usageMetadata ?? {};
  return {
    inputTokens: Number(u.promptTokenCount ?? 0) || 0,
    outputTokens: Number(u.candidatesTokenCount ?? 0) || 0,
  };
}

async function callGeminiBriefModel(env: Env, cfg: RssBriefConfig, sourceText: string): Promise<{ captionShort?: unknown; captionFull?: unknown; hashtags?: unknown } | null> {
  const apiKey = String((env as any).GEMINI_API_KEY ?? '').trim();
  const model = cfg.model;
  if (!apiKey) {
    await recordBriefUsage(env, 'gemini', model, 0, 0, 'failed', 'GEMINI_API_KEY not configured');
    return null;
  }

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: buildBriefSystem() }] },
        contents: [{ role: 'user', parts: [{ text: `SOURCE ARTICLE:\n${sourceText.slice(0, RSS_BRIEF_SOURCE_MAX_CHARS)}` }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 700 },
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });

    if (!res.ok) {
      const errText = await res.text();
      await recordBriefUsage(env, 'gemini', model, 0, 0, 'failed', `http_${res.status}:${errText.slice(0, 160)}`);
      return null;
    }

    const body = await res.json() as any;
    const usage = extractGeminiBriefUsage(body);
    await recordBriefUsage(env, 'gemini', model, usage.inputTokens, usage.outputTokens, 'success');

    const text = String((body?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('\n'));
    return extractJson(text);
  } catch (err) {
    await recordBriefUsage(env, 'gemini', model, 0, 0, 'failed', err instanceof Error ? err.message.slice(0, 160) : 'error');
    return null;
  }
}

async function callAnthropicBriefModel(env: Env, cfg: RssBriefConfig, sourceText: string): Promise<{ captionShort?: unknown; captionFull?: unknown; hashtags?: unknown } | null> {
  if (!(env as any).ANTHROPIC_API_KEY) return null;
  const model = cfg.model;
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': (env as any).ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VER,
      },
      body: JSON.stringify({
        model,
        max_tokens: 600,
        system: buildBriefSystem(),
        messages: [{ role: 'user', content: `SOURCE ARTICLE:\n${sourceText.slice(0, RSS_BRIEF_SOURCE_MAX_CHARS)}` }],
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });

    if (!res.ok) {
      const errText = await res.text();
      await recordBriefUsage(env, 'anthropic', model, 0, 0, 'failed', `http_${res.status}:${errText.slice(0, 160)}`);
      return null;
    }

    const body = await res.json() as any;
    await recordBriefUsage(env, 'anthropic', model, Number(body?.usage?.input_tokens ?? 0), Number(body?.usage?.output_tokens ?? 0), 'success');
    return extractJson(String(body?.content?.[0]?.text ?? ''));
  } catch (err) {
    await recordBriefUsage(env, 'anthropic', model, 0, 0, 'failed', err instanceof Error ? err.message.slice(0, 160) : 'error');
    return null;
  }
}

async function callBriefModel(env: Env, cfg: RssBriefConfig, sourceText: string): Promise<{ captionShort?: unknown; captionFull?: unknown; hashtags?: unknown } | null> {
  if (cfg.provider === 'gemini') return callGeminiBriefModel(env, cfg, sourceText);
  return callAnthropicBriefModel(env, cfg, sourceText);
}

export interface RssBriefOutcome {
  /** Updated score results aligned to the input order (briefed survivors). */
  results: AIGateResult[];
  /** Per-item brief failures. Caller releases these to pending (retry soon) and
   *  does NOT persist them, so a transient failure does not strand the article
   *  as selected-but-unpublished. */
  failedIndexes: number[];
  /** Survivors skipped because the daily brief budget is exhausted. Caller must
   *  release these to pending with the attempt DECREMENTED (so repeated deferral
   *  never burns attempt_count toward max-attempts) and must not persist them. */
  capDeferredIndexes: number[];
}

/**
 * Mirror of attachTranslations for RSS survivors: extract full text, generate a
 * copyright-safe Persian brief, and attach it under the channel language keys.
 * Per-item failures are reported via `failedIndexes` (released by the caller),
 * never persisted. Daily-capped to bound AI cost/latency.
 */
export async function enrichAndBriefRssSurvivors(
  env: Env,
  items: NormalizedItem[],
  scoreResults: AIGateResult[],
  _category: CategoryRow,
  channels: ChannelRow[],
  _labels: string[],
): Promise<RssBriefOutcome> {
  const extractCfg = getRssExtractorConfig(env);
  const briefCfg = getRssBriefConfig(env);
  const enabledChannels = channels.filter(c => c.enabled);
  const out = [...scoreResults];
  const failedIndexes: number[] = [];
  const capDeferredIndexes: number[] = [];
  let capLogged = false;

  let callsToday = await countBriefCallsToday(env, briefCfg);

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const result = scoreResults[i]!;
    if (!result.publish) continue;

    // Daily budget guard: once the cap is hit, report the remaining survivors to
    // the caller as cap-deferred. The caller releases them to pending with
    // decrementAttempt and excludes RSS for the rest of the tick.
    if (briefCfg.maxCallsPerDay > 0 && callsToday >= briefCfg.maxCallsPerDay) {
      if (!capLogged) {
        await recordBriefUsage(env, briefCfg.provider, briefCfg.model, 0, 0, 'skipped', `daily_cap_${callsToday}/${briefCfg.maxCallsPerDay}`);
        capLogged = true;
      }
      capDeferredIndexes.push(i);
      continue;
    }

    try {
      const { text: sourceText } = await extractFullTextForBrief(env, item, extractCfg);
      const raw = await callBriefModel(env, briefCfg, sourceText);
      callsToday++;
      const draft = raw ? sanitizeBrief(raw, sourceText) : null;

      if (!draft) {
        failedIndexes.push(i);
        continue;
      }

      const captionFull = draft.captionFull;
      const translation: TranslationOutput = {
        captionShort: draft.captionShort,
        captionFull,
        hashtags: draft.hashtags,
      };

      const translations: Record<string, TranslationOutput> = { ...result.translations };
      for (const channel of enabledChannels) {
        translations[channelTranslationKey(channel.id)] = translation;
        translations[channel.language] = translation;
      }
      out[i] = { ...result, translations };
    } catch (err) {
      console.warn('[RSSBrief] item failed:', err instanceof Error ? err.message : String(err));
      failedIndexes.push(i);
    }
  }

  return { results: out, failedIndexes, capDeferredIndexes };
}
