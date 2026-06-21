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
const CAPTION_SHORT_MAX = 220;

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
  const captionFull = clampCaption(draft.captionFull, CAPTION_FULL_MAX);
  if (captionFull.length < 40) return null;
  if (hasLongVerbatimOverlap(captionFull, sourceText)) return null;

  const captionShort = clampCaption(draft.captionShort || captionFull, CAPTION_SHORT_MAX);
  const hashtags = Array.isArray(draft.hashtags)
    ? draft.hashtags.map(h => String(h)).filter(Boolean).slice(0, 6)
    : [];

  return { captionShort, captionFull, hashtags };
}

function buildBriefSystem(): string {
  return [
    'You write original Persian (Farsi) news briefs for a crypto Telegram channel.',
    'You are given an English source article. Produce an ANALYTICAL Persian brief — not a translation.',
    'Rules:',
    '- Do NOT translate paragraph-by-paragraph. Do NOT preserve the article sentence order.',
    '- Do NOT include any direct quote from the article.',
    '- Write 5–8 short lines: what happened, why it matters, likely market impact.',
    '- Natural Persian. Numbers and entities accurate.',
    'Return ONLY JSON: {"captionShort":"...","captionFull":"...","hashtags":["#..."]}',
    'captionFull is the channel post body (no source link — it is appended automatically).',
    'captionShort is a one-line teaser. No markdown fences.',
  ].join('\n');
}

function extractJson(text: string): any | null {
  const cleaned = String(text ?? '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try { return JSON.parse(cleaned.slice(first, last + 1)); } catch { return null; }
}

async function recordBriefUsage(env: Env, model: string, inT: number, outT: number, status: string, note?: string): Promise<void> {
  if (!env.DB) return;
  try {
    const id = `rss_brief_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await env.DB.prepare(`
      INSERT INTO ai_usage (id, provider, purpose, model, input_tokens, output_tokens, status, error_message)
      VALUES (?, 'anthropic', 'rss_brief', ?, ?, ?, ?, ?)
    `).bind(id, model, Math.max(0, inT), Math.max(0, outT), status, note ?? null).run();
  } catch { /* best-effort */ }
}

async function callBriefModel(env: Env, sourceText: string): Promise<{ captionShort?: unknown; captionFull?: unknown; hashtags?: unknown } | null> {
  if (!env.ANTHROPIC_API_KEY) return null;
  const model = env.DUPLICATE_AI_JUDGE_MODEL || env.AI_SCORING_MODEL;
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VER,
      },
      body: JSON.stringify({
        model,
        max_tokens: 900,
        system: buildBriefSystem(),
        messages: [{ role: 'user', content: `SOURCE ARTICLE:\n${sourceText.slice(0, 6000)}` }],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      await recordBriefUsage(env, model, 0, 0, 'failed', `http_${res.status}`);
      return null;
    }
    const body = await res.json() as any;
    await recordBriefUsage(env, model, Number(body?.usage?.input_tokens ?? 0), Number(body?.usage?.output_tokens ?? 0), 'success');
    return extractJson(String(body?.content?.[0]?.text ?? ''));
  } catch (err) {
    await recordBriefUsage(env, model, 0, 0, 'failed', err instanceof Error ? err.message.slice(0, 120) : 'error');
    return null;
  }
}

/**
 * Mirror of attachTranslations for RSS survivors: extract full text, generate a
 * copyright-safe Persian brief, and attach it under the channel language keys.
 * Per-item failures set publish=false (+flag) rather than failing the batch.
 */
export async function enrichAndBriefRssSurvivors(
  env: Env,
  items: NormalizedItem[],
  scoreResults: AIGateResult[],
  category: CategoryRow,
  channels: ChannelRow[],
  labels: string[],
): Promise<AIGateResult[]> {
  const cfg = getRssExtractorConfig(env);
  const enabledChannels = channels.filter(c => c.enabled);
  const out = [...scoreResults];

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const result = scoreResults[i]!;
    if (!result.publish) continue;

    try {
      const { text: sourceText } = await extractFullTextForBrief(env, item, cfg);
      const raw = await callBriefModel(env, sourceText);
      const draft = raw ? sanitizeBrief(raw, sourceText) : null;

      if (!draft) {
        out[i] = { ...result, publish: false, riskFlags: [...result.riskFlags, 'rss_brief_failed'] };
        continue;
      }

      const captionFull = withAttribution(draft.captionFull, labels[i] || item.sourceAccount, item.sourceUrl);
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
      out[i] = { ...result, publish: false, riskFlags: [...result.riskFlags, 'rss_brief_failed'] };
    }
  }

  return out;
}
