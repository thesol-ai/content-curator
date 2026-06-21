// ── RSS full-text extraction (layered: feed → Jina → summary) ──
//
// Cost rule: scoring already happened on the feed summary; this runs only for
// survivors. We prefer the feed's own content:encoded (free), fall back to Jina
// Reader for short-summary feeds (capped, public articles only — never a paywall
// bypass), and finally to the feed summary so an item is never dropped here.

import type { Env, NormalizedItem } from '../types';

const JINA_BASE = 'https://r.jina.ai/';

export type ExtractionSource = 'feed' | 'jina' | 'summary';

export interface RssExtractorConfig {
  jinaEnabled: boolean;
  minContentChars: number;
  maxCallsPerDay: number;
  apiKey?: string;
  timeoutMs: number;
}

export function getRssExtractorConfig(env: Env): RssExtractorConfig {
  const n = (v: string | undefined, d: number) => {
    const x = Math.floor(Number(v));
    return Number.isFinite(x) ? x : d;
  };
  return {
    jinaEnabled: String(env.JINA_READER_ENABLED ?? '').toLowerCase() === 'true',
    minContentChars: Math.max(80, n(env.JINA_MIN_CONTENT_CHARS, 500)),
    maxCallsPerDay: Math.max(0, n(env.JINA_MAX_CALLS_PER_DAY, 50)),
    apiKey: env.JINA_API_KEY,
    timeoutMs: Math.max(3000, n(env.RSS_FEED_TIMEOUT_SEC, 10) * 1000),
  };
}

/**
 * Pure decision: given the feed's own full text and summary, decide where the
 * brief's source text should come from. `feed` if content:encoded is long
 * enough; otherwise `needs_jina` (caller may still be capped/disabled, in which
 * case it falls back to `summary`).
 */
export function chooseExtraction(
  feedFullText: string | undefined,
  minContentChars: number,
): 'feed' | 'needs_jina' {
  if ((feedFullText ?? '').trim().length >= minContentChars) return 'feed';
  return 'needs_jina';
}

const PAYWALL_MARKERS = [
  'subscribe to continue',
  'subscribers only',
  'create a free account',
  'sign in to read',
  'log in to read',
  'this content is for members',
  '403 forbidden',
  'access denied',
  'please enable javascript',
];

/** Heuristic: did Jina return a paywall/login-wall instead of the article? */
export function looksPaywalled(text: string): boolean {
  const t = text.toLowerCase().slice(0, 1500);
  return PAYWALL_MARKERS.some(m => t.includes(m));
}

async function countJinaCallsToday(env: Env): Promise<number> {
  if (!env.DB) return 0;
  try {
    // Count ALL attempts (success/skipped/error), not just successes — otherwise
    // a feed that keeps hitting paywalls/errors would retry Jina without bound.
    const row = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM ai_usage
      WHERE provider = 'jina' AND purpose = 'rss_fulltext'
        AND status IN ('success','skipped','error')
        AND created_at > datetime('now','-1 day')
    `).first<{ count: number }>();
    return Number(row?.count ?? 0);
  } catch {
    return 0;
  }
}

async function recordJinaUsage(env: Env, status: 'success' | 'skipped' | 'error', note?: string): Promise<void> {
  if (!env.DB) return;
  try {
    const id = `jina_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await env.DB.prepare(`
      INSERT INTO ai_usage (id, provider, purpose, model, input_tokens, output_tokens, status, error_message)
      VALUES (?, 'jina', 'rss_fulltext', 'jina-reader', 0, 0, ?, ?)
    `).bind(id, status, note ?? null).run();
  } catch { /* best-effort */ }
}

async function fetchViaJina(env: Env, cfg: RssExtractorConfig, articleUrl: string): Promise<string | null> {
  try {
    const headers: Record<string, string> = { 'Accept': 'text/plain' };
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    const res = await fetch(`${JINA_BASE}${articleUrl}`, {
      headers,
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) {
      await recordJinaUsage(env, 'error', `http_${res.status}`);
      return null;
    }
    const text = (await res.text()).trim();
    if (!text || looksPaywalled(text)) {
      await recordJinaUsage(env, 'skipped', 'paywall_or_empty');
      return null;
    }
    await recordJinaUsage(env, 'success');
    return text;
  } catch (err) {
    await recordJinaUsage(env, 'error', err instanceof Error ? err.message.slice(0, 120) : 'error');
    return null;
  }
}

export interface ExtractionResult {
  text: string;
  source: ExtractionSource;
}

/**
 * Best available full text for a single RSS survivor.
 * feed content:encoded → Jina (if enabled + under cap + public) → feed summary.
 */
export async function extractFullTextForBrief(
  env: Env,
  item: NormalizedItem,
  cfg: RssExtractorConfig = getRssExtractorConfig(env),
): Promise<ExtractionResult> {
  const summary = item.text ?? '';

  if (chooseExtraction(item.fullText, cfg.minContentChars) === 'feed') {
    return { text: item.fullText!, source: 'feed' };
  }

  if (cfg.jinaEnabled && cfg.maxCallsPerDay > 0) {
    const used = await countJinaCallsToday(env);
    if (used < cfg.maxCallsPerDay) {
      const jina = await fetchViaJina(env, cfg, item.sourceUrl);
      if (jina && jina.length >= cfg.minContentChars) {
        return { text: jina.slice(0, 8000), source: 'jina' };
      }
    } else {
      await recordJinaUsage(env, 'skipped', `daily_cap_${used}/${cfg.maxCallsPerDay}`);
    }
  }

  // Fall back to whatever the feed gave (summary, or short content:encoded).
  return { text: item.fullText && item.fullText.length > summary.length ? item.fullText : summary, source: 'summary' };
}
