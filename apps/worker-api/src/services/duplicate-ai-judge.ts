import type { AIGateResult, Env, NormalizedItem } from '../types';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VER = '2023-06-01';

export type DuplicateAiJudgeDecision =
  | 'duplicate'
  | 'near_duplicate'
  | 'new_angle'
  | 'material_followup'
  | 'different_story';

export interface DuplicateAiJudgeCandidate {
  index: number;
  item: NormalizedItem;
  ai: AIGateResult;
}

export interface DuplicateAiJudgePrior {
  priorId: string;
  sourceAccount: string | null;
  sourceUrl: string | null;
  text: string | null;
  captionShort: string | null;
  topicFingerprint: string | null;
  storyKey: string | null;
  eventType: string | null;
  canonicalDate: string | null;
  publishedAt: number | null;
}

export interface DuplicateAiJudgeResult {
  index: number;
  decision: DuplicateAiJudgeDecision;
  confidence: number;
  matchedPriorId: string | null;
  reason: string;
}

interface DuplicateAiJudgeConfig {
  enabled: boolean;
  model: string;
  batchSize: number;
  maxPriors: number;
  windowHours: number;
  maxTextChars: number;
  maxCallsPerDay: number;
  confidenceThreshold: number;
}

function parseIntEnv(value: string | undefined, fallback: number, min = 1, max = 1000): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseFloatEnv(value: string | undefined, fallback: number, min = 0, max = 1): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function isDuplicateAiJudgeEnabled(env: Env): boolean {
  return String(env.DUPLICATE_AI_JUDGE_ENABLED ?? '').toLowerCase() === 'true';
}

export function getDuplicateAiJudgeConfig(env: Env): DuplicateAiJudgeConfig {
  return {
    enabled: isDuplicateAiJudgeEnabled(env),
    model: env.DUPLICATE_AI_JUDGE_MODEL || env.AI_SCORING_MODEL,
    batchSize: parseIntEnv(env.DUPLICATE_AI_JUDGE_BATCH_SIZE, 5, 1, 10),
    maxPriors: parseIntEnv(env.DUPLICATE_AI_JUDGE_MAX_PRIORS, 20, 1, 50),
    windowHours: parseIntEnv(env.DUPLICATE_AI_JUDGE_WINDOW_HOURS || env.STORY_INTELLIGENCE_WINDOW_HOURS, 72, 1, 168),
    maxTextChars: parseIntEnv(env.DUPLICATE_AI_JUDGE_MAX_TEXT_CHARS, 220, 80, 800),
    maxCallsPerDay: parseIntEnv(env.DUPLICATE_AI_JUDGE_MAX_CALLS_PER_DAY, 14, 0, 200),
    confidenceThreshold: parseFloatEnv(env.DUPLICATE_AI_JUDGE_CONFIDENCE_THRESHOLD, 0.78, 0.5, 0.99),
  };
}

function truncateText(value: unknown, maxChars: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars).trim();
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function shouldRejectDuplicateAiJudgeResult(
  result: DuplicateAiJudgeResult,
  confidenceThreshold: number,
): boolean {
  return (result.decision === 'duplicate' || result.decision === 'near_duplicate')
    && result.confidence >= confidenceThreshold;
}

export function shapeDuplicateAiJudgePayload(args: {
  candidates: DuplicateAiJudgeCandidate[];
  priors: DuplicateAiJudgePrior[];
  maxTextChars: number;
}): Record<string, unknown> {
  return {
    new_items: args.candidates.map(candidate => ({
      index: candidate.index,
      source_account: candidate.item.sourceAccount,
      source_url: candidate.item.sourceUrl,
      post_id: candidate.item.postId,
      text: truncateText(candidate.item.text, args.maxTextChars),
      topic_fingerprint: candidate.ai.topicFingerprint ?? null,
      story_key: candidate.ai.storyKey ?? null,
      primary_entities: candidate.ai.storyFields?.primaryEntities ?? [],
      event_type: candidate.ai.storyFields?.eventType ?? null,
      canonical_date: candidate.ai.storyFields?.canonicalDate ?? null,
      score: candidate.ai.score ?? null,
    })),
    previous_items: args.priors.map(prior => ({
      prior_id: prior.priorId,
      source_account: prior.sourceAccount,
      source_url: prior.sourceUrl,
      text: truncateText(prior.text || prior.captionShort, args.maxTextChars),
      caption_short: truncateText(prior.captionShort, args.maxTextChars),
      topic_fingerprint: prior.topicFingerprint,
      story_key: prior.storyKey,
      event_type: prior.eventType,
      canonical_date: prior.canonicalDate,
      published_at: prior.publishedAt,
    })),
  };
}

async function countDuplicateJudgeCallsToday(env: Env): Promise<number> {
  if (!env.DB) return 0;
  try {
    const row = await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM ai_usage
      WHERE provider = 'anthropic'
        AND purpose = 'duplicate_judge'
        AND status = 'success'
        AND created_at > datetime('now','-1 day')
    `).first<{ count: number }>();
    return Number(row?.count ?? 0);
  } catch (err) {
    console.warn('[DuplicateAIJudge] call budget check skipped:', err instanceof Error ? err.message : String(err));
    return 0;
  }
}

async function recordDuplicateJudgeUsage(
  env: Env,
  args: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    status: 'success' | 'failed' | 'skipped';
    errorMessage?: string;
  },
): Promise<void> {
  if (!env.DB) return;
  try {
    const id = `dupe_ai_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await env.DB.prepare(`
      INSERT INTO ai_usage (id, provider, purpose, model, input_tokens, output_tokens, status, error_message)
      VALUES (?, 'anthropic', 'duplicate_judge', ?, ?, ?, ?, ?)
    `).bind(
      id,
      args.model,
      Math.max(0, Math.floor(args.inputTokens)),
      Math.max(0, Math.floor(args.outputTokens)),
      args.status,
      args.errorMessage ?? null,
    ).run();
  } catch (err) {
    console.warn('[DuplicateAIJudge] usage record failed:', err instanceof Error ? err.message : String(err));
  }
}

export async function fetchRecentDuplicateJudgePriors(
  env: Env,
  args: {
    categoryId: string;
    channelId: string | null;
    windowHours: number;
    maxPriors: number;
    maxTextChars: number;
  },
): Promise<DuplicateAiJudgePrior[]> {
  if (!env.DB || !args.channelId) return [];

  try {
    const seconds = Math.max(1, Math.floor(args.windowHours * 3600));
    const limit = Math.max(args.maxPriors * 3, args.maxPriors);

    const res = await env.DB.prepare(`
      SELECT
        q.id AS prior_id,
        q.source_url AS queue_source_url,
        q.caption_short,
        q.published_at,
        q.scheduled_at,
        d.source_account,
        d.source_url,
        d.text AS source_text,
        d.topic_fingerprint,
        sie.story_key,
        sie.event_type,
        sie.canonical_date
      FROM publish_queue q
      JOIN discovery_items d ON d.id = q.item_id
      LEFT JOIN story_intelligence_events sie
        ON sie.discovery_item_id = q.item_id
       AND (sie.channel_id = q.channel_id OR sie.channel_id IS NULL)
       AND sie.status IN ('queued','published')
      WHERE q.channel_id = ?
        AND d.category_id = ?
        AND q.status IN ('scheduled','publishing','retry','published')
        AND COALESCE(q.published_at, q.scheduled_at, 0) >= unixepoch('now') - ?
      ORDER BY COALESCE(q.published_at, q.scheduled_at, 0) DESC
      LIMIT ?
    `).bind(args.channelId, args.categoryId, seconds, limit).all<any>();

    const seen = new Set<string>();
    const out: DuplicateAiJudgePrior[] = [];

    for (const row of res.results ?? []) {
      const priorId = String(row.prior_id ?? '');
      if (!priorId || seen.has(priorId)) continue;
      seen.add(priorId);

      out.push({
        priorId,
        sourceAccount: row.source_account ?? null,
        sourceUrl: row.source_url ?? row.queue_source_url ?? null,
        text: truncateText(row.source_text ?? '', args.maxTextChars),
        captionShort: truncateText(row.caption_short ?? '', args.maxTextChars),
        topicFingerprint: row.topic_fingerprint ?? null,
        storyKey: row.story_key ?? null,
        eventType: row.event_type ?? null,
        canonicalDate: row.canonical_date ?? null,
        publishedAt: Number(row.published_at ?? row.scheduled_at ?? 0) || null,
      });

      if (out.length >= args.maxPriors) break;
    }

    return out;
  } catch (err) {
    console.warn('[DuplicateAIJudge] prior fetch skipped:', err instanceof Error ? err.message : String(err));
    return [];
  }
}

function buildDuplicateJudgeSystem(confidenceThreshold: number): string {
  return [
    'You are a strict duplicate detector for a Telegram news publishing queue.',
    'Compare NEW_ITEMS against PREVIOUS_ITEMS from the same channel.',
    'Mark duplicate or near_duplicate when the new item is the same underlying story/event as a previous item, even if wording, source, URL, or story_key differs.',
    'Do NOT mark duplicate when the new item is a materially new follow-up: recovery, arrest, exploit update with new funds, official decision, court ruling, approval, denial, settlement, patch/fix, or a genuinely new company/product under the same broad law.',
    'Do NOT mark duplicate just because both items mention the same chain, token, country, broad topic, or market sector.',
    `Reject-worthy decisions are duplicate or near_duplicate with confidence >= ${confidenceThreshold}.`,
    'Return ONLY JSON with this exact shape:',
    '{"items":[{"index":0,"decision":"duplicate","confidence":0.91,"matched_prior_id":"...","reason":"same event, entities and amount"}]}',
    'decision must be one of: duplicate, near_duplicate, new_angle, material_followup, different_story.',
    'No markdown. No explanation outside JSON.',
  ].join('\n');
}

function extractJudgeJson(text: string): { items: any[] } | null {
  const cleaned = String(text ?? '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first < 0 || last <= first) return null;

  try {
    const parsed = JSON.parse(cleaned.slice(first, last + 1));
    return parsed && typeof parsed === 'object' && Array.isArray(parsed.items) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeJudgeResult(raw: any): DuplicateAiJudgeResult | null {
  const decision = String(raw?.decision ?? '').trim() as DuplicateAiJudgeDecision;
  if (!['duplicate', 'near_duplicate', 'new_angle', 'material_followup', 'different_story'].includes(decision)) return null;

  const index = Math.floor(Number(raw?.index));
  if (!Number.isFinite(index) || index < 0) return null;

  const confidence = Math.max(0, Math.min(1, Number(raw?.confidence ?? 0)));

  return {
    index,
    decision,
    confidence,
    matchedPriorId: typeof raw?.matched_prior_id === 'string' ? raw.matched_prior_id : null,
    reason: String(raw?.reason ?? '').slice(0, 500),
  };
}

function extractAnthropicUsage(body: any): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: Number(body?.usage?.input_tokens ?? 0) || 0,
    outputTokens: Number(body?.usage?.output_tokens ?? 0) || 0,
  };
}

async function callDuplicateJudge(
  env: Env,
  cfg: DuplicateAiJudgeConfig,
  candidates: DuplicateAiJudgeCandidate[],
  priors: DuplicateAiJudgePrior[],
): Promise<DuplicateAiJudgeResult[]> {
  if (!env.ANTHROPIC_API_KEY) return [];

  const payload = shapeDuplicateAiJudgePayload({
    candidates,
    priors,
    maxTextChars: cfg.maxTextChars,
  });

  const system = buildDuplicateJudgeSystem(cfg.confidenceThreshold);
  const user = [
    'PREVIOUS_ITEMS and NEW_ITEMS are JSON below.',
    'Return a decision for every item in NEW_ITEMS.',
    JSON.stringify(payload),
  ].join('\n');

  try {
    const response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VER,
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 1200,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(45_000),
    });

    if (!response.ok) {
      await recordDuplicateJudgeUsage(env, {
        model: cfg.model,
        inputTokens: 0,
        outputTokens: 0,
        status: 'failed',
        errorMessage: `Claude HTTP ${response.status}`,
      });
      return [];
    }

    const body = await response.json() as any;
    const usage = extractAnthropicUsage(body);
    await recordDuplicateJudgeUsage(env, {
      model: cfg.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      status: 'success',
    });

    const text = String(body?.content?.[0]?.text ?? '');
    const parsed = extractJudgeJson(text);
    if (!parsed) return [];

    return parsed.items
      .map(normalizeJudgeResult)
      .filter((item): item is DuplicateAiJudgeResult => item !== null);
  } catch (err) {
    await recordDuplicateJudgeUsage(env, {
      model: cfg.model,
      inputTokens: 0,
      outputTokens: 0,
      status: 'failed',
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    console.warn('[DuplicateAIJudge] call failed:', err instanceof Error ? err.message : String(err));
    return [];
  }
}

export async function runDuplicateAiJudgeForSurvivors(
  env: Env,
  args: {
    categoryId: string;
    channelId: string | null;
    candidates: DuplicateAiJudgeCandidate[];
  },
): Promise<Map<number, DuplicateAiJudgeResult>> {
  const cfg = getDuplicateAiJudgeConfig(env);
  const rejected = new Map<number, DuplicateAiJudgeResult>();

  if (!cfg.enabled || args.candidates.length === 0 || cfg.maxCallsPerDay <= 0) return rejected;

  const priors = await fetchRecentDuplicateJudgePriors(env, {
    categoryId: args.categoryId,
    channelId: args.channelId,
    windowHours: cfg.windowHours,
    maxPriors: cfg.maxPriors,
    maxTextChars: cfg.maxTextChars,
  });

  if (priors.length === 0) return rejected;

  for (const candidates of chunk(args.candidates, cfg.batchSize)) {
    const callsToday = await countDuplicateJudgeCallsToday(env);
    if (callsToday >= cfg.maxCallsPerDay) {
      await recordDuplicateJudgeUsage(env, {
        model: cfg.model,
        inputTokens: 0,
        outputTokens: 0,
        status: 'skipped',
        errorMessage: `duplicate_judge_daily_cap:${callsToday}/${cfg.maxCallsPerDay}`,
      });
      break;
    }

    const results = await callDuplicateJudge(env, cfg, candidates, priors);
    for (const result of results) {
      if (shouldRejectDuplicateAiJudgeResult(result, cfg.confidenceThreshold)) {
        rejected.set(result.index, result);
      }
    }
  }

  return rejected;
}
