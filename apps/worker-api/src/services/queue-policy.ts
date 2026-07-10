import type { ChannelRow, Env } from '../types';

export interface SourcePolicyRow {
  sourceAccount: string;
  scheduledNext24h: number;
  scheduledToday: number;
  publishedToday: number;
  usedToday: number;
  shareNext24h: number;
  full: boolean;
  throttled: boolean;
}

export interface QueuePolicyDecision {
  channelId: string;
  scheduledNext6h: number;
  scheduledNext24h: number;
  scheduledTotal: number;
  targetNext24h: number;
  softBrakeAt: number;
  hardBrakeAt: number;
  sourceSoftCap: number;
  shouldRunApify: boolean;
  shouldRunAi: boolean;
  shouldRunTranslation: boolean;
  mode: 'open' | 'limited' | 'soft_brake' | 'hard_brake';
  sourcePolicy: SourcePolicyRow[];
}

function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function boolEnv(env: Env, key: string, fallback: boolean): boolean {
  const raw = String((env as any)[key] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

export function isQueuePolicyEnforcementEnabled(env: Env): boolean {
  // Fail closed. Queue policy can stop AI/backlog processing, so it must never
  // become active merely because an environment variable is absent.
  return boolEnv(env, 'QUEUE_POLICY_ENFORCEMENT_ENABLED', false);
}

export function policyEnvNumber(env: Env, key: string, fallback: number): number {
  const value = (env as any)[key];
  return num(value, fallback);
}

export async function getQueuePolicyDecision(
  env: Env,
  channel: ChannelRow,
): Promise<QueuePolicyDecision> {
  const channelId = channel.id;
  const maxPerDay = num((channel as any).max_per_day, 64);
  const sourceSoftCap = num((channel as any).max_posts_per_source_per_day, 15);

  const targetNext24h = policyEnvNumber(env, 'QUEUE_POLICY_TARGET_NEXT_24H', 24);
  const softBrakeAt = policyEnvNumber(env, 'QUEUE_POLICY_SOFT_BRAKE_NEXT_24H', 40);
  const hardBrakeAt = policyEnvNumber(
    env,
    'QUEUE_POLICY_HARD_BRAKE_NEXT_24H',
    Math.max(56, Math.floor(maxPerDay * 0.875)),
  );

  const summary = await env.DB.prepare(`
    SELECT
      COUNT(*) AS scheduled_total,
      SUM(CASE WHEN scheduled_at <= unixepoch('now', '+6 hours') THEN 1 ELSE 0 END) AS scheduled_next_6h,
      SUM(CASE WHEN scheduled_at <= unixepoch('now', '+24 hours') THEN 1 ELSE 0 END) AS scheduled_next_24h
    FROM publish_queue
    WHERE channel_id = ?
      AND status IN ('scheduled','retry')
  `).bind(channelId).first<{
    scheduled_total: number | null;
    scheduled_next_6h: number | null;
    scheduled_next_24h: number | null;
  }>();

  const scheduledTotal = num(summary?.scheduled_total, 0);
  const scheduledNext6h = num(summary?.scheduled_next_6h, 0);
  const scheduledNext24h = num(summary?.scheduled_next_24h, 0);

  const rows = await env.DB.prepare(`
    SELECT
      COALESCE(d.source_account, c.source_account, 'unknown') AS source_account,
      SUM(CASE
        WHEN q.status IN ('scheduled','retry')
          AND q.scheduled_at <= unixepoch('now', '+24 hours')
        THEN 1 ELSE 0
      END) AS scheduled_next_24h,
      SUM(CASE
        WHEN q.status IN ('scheduled','retry')
          AND date(datetime(q.scheduled_at, 'unixepoch', '+3 hours', '+30 minutes')) =
              date(datetime('now', '+3 hours', '+30 minutes'))
        THEN 1 ELSE 0
      END) AS scheduled_today,
      SUM(CASE
        WHEN q.status = 'published'
          AND date(datetime(q.scheduled_at, 'unixepoch', '+3 hours', '+30 minutes')) =
              date(datetime('now', '+3 hours', '+30 minutes'))
        THEN 1 ELSE 0
      END) AS published_today
    FROM publish_queue q
    LEFT JOIN discovery_items d ON d.id = q.item_id
    LEFT JOIN ai_candidate_queue c ON c.id = q.candidate_id
    WHERE q.channel_id = ?
      AND q.status IN ('scheduled','retry','published')
      AND q.scheduled_at IS NOT NULL
      AND q.scheduled_at >= unixepoch('now', '-36 hours')
      AND q.scheduled_at <= unixepoch('now', '+24 hours')
    GROUP BY COALESCE(d.source_account, c.source_account, 'unknown')
    HAVING scheduled_next_24h > 0 OR scheduled_today > 0 OR published_today > 0
    ORDER BY (COALESCE(scheduled_today, 0) + COALESCE(published_today, 0)) DESC
  `).bind(channelId).all<{
    source_account: string;
    scheduled_next_24h: number | null;
    scheduled_today: number | null;
    published_today: number | null;
  }>();

  const sourcePolicy = (rows.results ?? []).map((row): SourcePolicyRow => {
    const scheduledForSourceNext24h = num(row.scheduled_next_24h, 0);
    const scheduledForSourceToday = num(row.scheduled_today, 0);
    const publishedForSourceToday = num(row.published_today, 0);
    const usedToday = scheduledForSourceToday + publishedForSourceToday;
    const shareNext24h = scheduledNext24h > 0 ? scheduledForSourceNext24h / scheduledNext24h : 0;

    return {
      sourceAccount: row.source_account,
      scheduledNext24h: scheduledForSourceNext24h,
      scheduledToday: scheduledForSourceToday,
      publishedToday: publishedForSourceToday,
      usedToday,
      shareNext24h,
      full: usedToday >= sourceSoftCap,
      throttled: usedToday >= Math.max(1, Math.floor(sourceSoftCap * 0.7)),
    };
  });

  let mode: QueuePolicyDecision['mode'] = 'open';
  if (scheduledNext24h >= hardBrakeAt) {
    mode = 'hard_brake';
  } else if (scheduledNext24h >= softBrakeAt) {
    mode = 'soft_brake';
  } else if (scheduledNext24h >= targetNext24h) {
    mode = 'limited';
  }

  return {
    channelId,
    scheduledNext6h,
    scheduledNext24h,
    scheduledTotal,
    targetNext24h,
    softBrakeAt,
    hardBrakeAt,
    sourceSoftCap,
    shouldRunApify: false,
    shouldRunAi: mode === 'open' || mode === 'limited',
    shouldRunTranslation: mode === 'open' || mode === 'limited',
    mode,
    sourcePolicy,
  };
}

export function isSourceBlockedByPolicy(
  decision: QueuePolicyDecision,
  sourceAccount: string | null | undefined,
): boolean {
  if (!sourceAccount) return false;
  const normalized = sourceAccount.toLowerCase();
  const source = decision.sourcePolicy.find(row => row.sourceAccount.toLowerCase() === normalized);
  if (!source) return false;
  return source.full || decision.mode === 'hard_brake';
}
