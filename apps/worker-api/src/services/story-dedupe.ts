import type { Env } from '../types';

export interface RecentStoryDuplicate {
  duplicate: boolean;
  topicFingerprint: string;
  queueId?: string;
  itemId?: string;
  status?: string;
  sourceAccount?: string;
  publishedAt?: number | null;
  scheduledAt?: number | null;
}

const GENERIC_FINGERPRINTS = new Set([
  'crypto-news',
  'market-update',
  'bitcoin-update',
  'ethereum-update',
  'stablecoin-update',
  'regulation-update',
  'defi-update',
  'altcoin-update',
]);

export function normalizeStoryFingerprint(value: unknown): string | null {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw || raw.length < 8) return null;
  if (raw.startsWith('ns-') || raw.startsWith('fp-')) return null;
  if (GENERIC_FINGERPRINTS.has(raw)) return null;
  if (!/^[a-z0-9][a-z0-9_-]{6,119}$/.test(raw)) return null;
  return raw;
}

export function getStoryDedupeWindowHours(channel: unknown, fallback = 72): number {
  const raw = Number((channel as any)?.semantic_dedupe_window_hours ?? (channel as any)?.story_dedupe_window_hours);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.max(1, Math.min(168, Math.floor(raw)));
}

export async function findRecentStoryDuplicate(
  env: Env,
  channelId: string,
  topicFingerprint: unknown,
  windowHours = 72,
): Promise<RecentStoryDuplicate> {
  const fingerprint = normalizeStoryFingerprint(topicFingerprint);
  if (!fingerprint) return { duplicate: false, topicFingerprint: '' };

  try {
    const row = await env.DB.prepare(`
      SELECT
        q.id AS queue_id,
        q.item_id AS item_id,
        q.status AS status,
        q.published_at AS published_at,
        q.scheduled_at AS scheduled_at,
        d.source_account AS source_account
      FROM publish_queue q
      JOIN discovery_items d ON d.id = q.item_id
      WHERE q.channel_id = ?
        AND q.status IN ('scheduled','retry','publishing','published')
        AND lower(d.topic_fingerprint) = ?
        AND COALESCE(q.published_at, q.scheduled_at) >= unixepoch('now', '-' || ? || ' hours')
      ORDER BY COALESCE(q.published_at, q.scheduled_at) DESC
      LIMIT 1
    `).bind(channelId, fingerprint, String(windowHours)).first<{
      queue_id: string;
      item_id: string;
      status: string;
      published_at: number | null;
      scheduled_at: number | null;
      source_account: string | null;
    }>();

    if (!row) return { duplicate: false, topicFingerprint: fingerprint };

    return {
      duplicate: true,
      topicFingerprint: fingerprint,
      queueId: row.queue_id,
      itemId: row.item_id,
      status: row.status,
      publishedAt: row.published_at,
      scheduledAt: row.scheduled_at,
      sourceAccount: row.source_account ?? undefined,
    };
  } catch (err) {
    console.warn('[StoryDedupe] skipped:', err instanceof Error ? err.message : String(err));
    return { duplicate: false, topicFingerprint: fingerprint };
  }
}
