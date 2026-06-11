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
  existingTopicFingerprint?: string;
  storyDedupeKey?: string;
  matchType?: 'exact' | 'family';
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

const FUNDING_SIGNAL_WORDS = new Set([
  'funding',
  'fundraise',
  'fundraising',
  'financing',
  'investment',
  'investments',
  'raise',
  'raises',
  'raised',
  'round',
  'series',
  'seed',
]);

const FUNDING_DETAIL_WORDS = new Set([
  'round',
  'series',
  'seed',
  'preseed',
  'pre',
  'a',
  'b',
  'c',
  'd',
  'e',
]);

const NON_FUNDRAISE_PHRASES = [
  'funding-rate',
  'funding-rates',
];

function buildFundingStoryFamilyKey(fingerprint: string): string | null {
  for (const phrase of NON_FUNDRAISE_PHRASES) {
    if (fingerprint.includes(phrase)) return null;
  }

  const tokens = fingerprint.split(/[-_]+/).map(t => t.trim()).filter(Boolean);
  if (tokens.length < 3) return null;

  const hasFundingSignal = tokens.some(t => FUNDING_SIGNAL_WORDS.has(t));
  if (!hasFundingSignal) return null;

  const entityTokens = tokens.filter(t =>
    !FUNDING_SIGNAL_WORDS.has(t) &&
    !FUNDING_DETAIL_WORDS.has(t) &&
    !/^\d+$/.test(t)
  );

  if (entityTokens.length < 2) return null;

  return `${entityTokens.join('-')}-funding`;
}

export function normalizeStoryFamilyKey(value: unknown): string | null {
  const fingerprint = normalizeStoryFingerprint(value);
  if (!fingerprint) return null;

  return buildFundingStoryFamilyKey(fingerprint) ?? fingerprint;
}

function shouldUseStoryFamilyDedupe(value: unknown): boolean {
  const fingerprint = normalizeStoryFingerprint(value);
  if (!fingerprint) return false;

  return buildFundingStoryFamilyKey(fingerprint) !== null;
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

    if (row) {
      return {
        duplicate: true,
        topicFingerprint: fingerprint,
        queueId: row.queue_id,
        itemId: row.item_id,
        status: row.status,
        publishedAt: row.published_at,
        scheduledAt: row.scheduled_at,
        sourceAccount: row.source_account ?? undefined,
        matchType: 'exact',
      };
    }

    const storyDedupeKey = normalizeStoryFamilyKey(fingerprint);
    if (!storyDedupeKey || !shouldUseStoryFamilyDedupe(fingerprint)) {
      return { duplicate: false, topicFingerprint: fingerprint };
    }

    const recent = await env.DB.prepare(`
      SELECT
        q.id AS queue_id,
        q.item_id AS item_id,
        q.status AS status,
        q.published_at AS published_at,
        q.scheduled_at AS scheduled_at,
        d.source_account AS source_account,
        d.topic_fingerprint AS topic_fingerprint
      FROM publish_queue q
      JOIN discovery_items d ON d.id = q.item_id
      WHERE q.channel_id = ?
        AND q.status IN ('scheduled','retry','publishing','published')
        AND COALESCE(q.published_at, q.scheduled_at) >= unixepoch('now', '-' || ? || ' hours')
      ORDER BY COALESCE(q.published_at, q.scheduled_at) DESC
      LIMIT 300
    `).bind(channelId, String(windowHours)).all<{
      queue_id: string;
      item_id: string;
      status: string;
      published_at: number | null;
      scheduled_at: number | null;
      source_account: string | null;
      topic_fingerprint: string | null;
    }>();

    const familyMatch = (recent.results ?? []).find(candidate =>
      normalizeStoryFamilyKey(candidate.topic_fingerprint) === storyDedupeKey
    );

    if (!familyMatch) return { duplicate: false, topicFingerprint: fingerprint, storyDedupeKey };

    return {
      duplicate: true,
      topicFingerprint: fingerprint,
      existingTopicFingerprint: familyMatch.topic_fingerprint ?? undefined,
      storyDedupeKey,
      matchType: 'family',
      queueId: familyMatch.queue_id,
      itemId: familyMatch.item_id,
      status: familyMatch.status,
      publishedAt: familyMatch.published_at,
      scheduledAt: familyMatch.scheduled_at,
      sourceAccount: familyMatch.source_account ?? undefined,
    };
  } catch (err) {
    console.warn('[StoryDedupe] skipped:', err instanceof Error ? err.message : String(err));
    return { duplicate: false, topicFingerprint: fingerprint };
  }
}
