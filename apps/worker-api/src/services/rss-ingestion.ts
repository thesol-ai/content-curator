// ── RSS ingestion orchestrator ────────────────────────────────
//
// Polls enabled rss_sources on an interval and pushes new articles into the
// SAME rail as Apify items: enqueueCandidates → backlog-drain → publish_queue.
// It does NOT write discovery_items directly (those are created post-AI by
// backlog-drain.saveDiscoveryItem). Each feed is isolated (own try/catch, short
// timeout); one bad feed never affects others or the Apify path.

import type { Env, NormalizedItem } from '../types';
import { normalizeRssItem } from './apify-client';
import { fetchFeed } from './rss-feed-fetcher';
import { computeDedupeKeys, isDuplicate } from './dedupe';
import { enqueueCandidates } from './candidate-queue';

interface RssSourceRow {
  id: string;
  category_id: string;
  feed_url: string;
  label: string;
  source_account: string;
  enabled: number;
  poll_interval_minutes: number;
  last_checked_at: string | null;
  etag: string | null;
  last_modified: string | null;
  last_seen_item_published_at: number | null;
}

export interface RssIngestConfig {
  enabled: boolean;
  probeOnly: boolean;
  intervalMin: number;
  maxItemsPerFeed: number;
  maxNewItemsPerRun: number;
  maxNewItemsPerDay: number;
  feedTimeoutMs: number;
}

function intEnv(v: string | undefined, d: number, min = 0): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(min, n) : d;
}

export function getRssIngestConfig(env: Env): RssIngestConfig {
  return {
    enabled: String(env.RSS_INGEST_ENABLED ?? '').toLowerCase() === 'true',
    probeOnly: String(env.RSS_FEED_PROBE_ONLY ?? '').toLowerCase() === 'true',
    intervalMin: intEnv(env.RSS_INGEST_INTERVAL_MIN, 30, 1),
    maxItemsPerFeed: intEnv(env.RSS_MAX_ITEMS_PER_FEED, 4, 0),
    maxNewItemsPerRun: intEnv(env.RSS_MAX_NEW_ITEMS_PER_RUN, 12, 0),
    maxNewItemsPerDay: intEnv(env.RSS_MAX_NEW_ITEMS_PER_DAY, 80, 0),
    feedTimeoutMs: intEnv(env.RSS_FEED_TIMEOUT_SEC, 10, 3) * 1000,
  };
}

/**
 * Pure: pick items newer than the watermark, newest first, capped per feed.
 * Items with no usable publishedAt are kept (dedupe is the precise idempotency
 * guard downstream).
 */
export function filterNewByWatermark(
  items: NormalizedItem[],
  lastPublishedAt: number | null,
  maxPerFeed: number,
): NormalizedItem[] {
  const fresh = items
    .filter(it => lastPublishedAt == null || it.publishedAt > lastPublishedAt)
    .sort((a, b) => b.publishedAt - a.publishedAt);
  return maxPerFeed > 0 ? fresh.slice(0, maxPerFeed) : fresh;
}

function rid(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function claimRssSlot(env: Env, sourceId: string, slot: number): Promise<boolean> {
  const key = `rss_ingest_slot:${sourceId}:${slot}`;
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, 'claimed', CURRENT_TIMESTAMP)`,
  ).bind(key).run();
  return (res.meta.changes ?? 0) > 0;
}

async function countRssEnqueuedToday(env: Env): Promise<number> {
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM ai_candidate_queue WHERE platform = 'rss' AND created_at > datetime('now','-1 day')`,
    ).first<{ c: number }>();
    return Number(row?.c ?? 0);
  } catch { return 0; }
}

async function updateSourceBookkeeping(
  env: Env,
  sourceId: string,
  patch: {
    status: number;
    error: string | null;
    etag: string | null;
    lastModified: string | null;
    /** error === null (a 304 is healthy: nothing changed, not a failure). */
    healthy: boolean;
    /** Persist ETag/Last-Modified for the LIVE path. False in probe-only so a
     *  probe run can never make the first real ingestion get a 304 and stall. */
    storeConditional: boolean;
  },
): Promise<void> {
  try {
    const h = patch.healthy ? 1 : 0;
    const store = patch.storeConditional ? 1 : 0;
    await env.DB.prepare(`
      UPDATE rss_sources SET
        last_checked_at = CURRENT_TIMESTAMP,
        last_http_status = ?,
        last_error = ?,
        last_success_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE last_success_at END,
        consecutive_failures = CASE WHEN ? = 1 THEN 0 ELSE consecutive_failures + 1 END,
        etag = CASE WHEN ? = 1 THEN COALESCE(?, etag) ELSE etag END,
        last_modified = CASE WHEN ? = 1 THEN COALESCE(?, last_modified) ELSE last_modified END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      patch.status, patch.error, h, h,
      store, patch.etag, store, patch.lastModified, sourceId,
    ).run();
  } catch (err) {
    console.warn('[RSSIngest] bookkeeping failed:', err instanceof Error ? err.message : String(err));
  }
}

/** Remove RSS slot-claim keys older than 2 days from the settings table. */
export async function cleanupOldRssIngestClaims(env: Env): Promise<{ deleted: number }> {
  if (!env.DB) return { deleted: 0 };
  try {
    const res = await env.DB.prepare(
      `DELETE FROM settings WHERE key LIKE 'rss_ingest_slot:%' AND updated_at < datetime('now','-2 days')`,
    ).run();
    return { deleted: res.meta.changes ?? 0 };
  } catch (err) {
    console.warn('[RSSIngest] slot cleanup failed:', err instanceof Error ? err.message : String(err));
    return { deleted: 0 };
  }
}

async function advanceWatermark(env: Env, sourceId: string, items: NormalizedItem[]): Promise<void> {
  if (items.length === 0) return;
  const newest = items.reduce((a, b) => (b.publishedAt > a.publishedAt ? b : a));
  try {
    await env.DB.prepare(
      `UPDATE rss_sources SET last_seen_item_url = ?, last_seen_item_published_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).bind(newest.sourceUrl, newest.publishedAt, sourceId).run();
  } catch { /* best-effort */ }
}

export interface RssIngestSummary {
  skipped: boolean;
  reason?: string;
  feeds: Array<{
    source: string; status: number; fetched: number; fresh: number;
    enqueued: number; duplicate?: number; droppedByCap?: number;
    error?: string | null; probe?: boolean; notModified?: boolean;
  }>;
  totalEnqueued: number;
}

export async function runRssIngestion(env: Env, opts?: { categoryId?: string }): Promise<RssIngestSummary> {
  const cfg = getRssIngestConfig(env);
  const summary: RssIngestSummary = { skipped: false, feeds: [], totalEnqueued: 0 };

  if (!cfg.enabled) return { ...summary, skipped: true, reason: 'disabled' };
  if (!env.DB) return { ...summary, skipped: true, reason: 'no_db' };

  let sources: RssSourceRow[];
  try {
    const res = await env.DB.prepare(`
      SELECT id, category_id, feed_url, label, source_account, enabled, poll_interval_minutes,
             last_checked_at, etag, last_modified, last_seen_item_published_at
      FROM rss_sources
      WHERE enabled = 1 ${opts?.categoryId ? 'AND category_id = ?' : ''}
      ORDER BY id
    `).bind(...(opts?.categoryId ? [opts.categoryId] : [])).all<RssSourceRow>();
    sources = res.results ?? [];
  } catch (err) {
    return { ...summary, skipped: true, reason: `query_failed:${err instanceof Error ? err.message : 'err'}` };
  }
  if (sources.length === 0) return { ...summary, skipped: true, reason: 'no_sources' };

  let dayCount = await countRssEnqueuedToday(env);
  const runId = rid('rssrun');
  let runCreated = false;
  let runCategoryId = opts?.categoryId ?? null;
  let runEnqueued = 0;
  let runFetched = 0;
  let runDuplicate = 0;

  for (const src of sources) {
    if (cfg.maxNewItemsPerRun > 0 && runEnqueued >= cfg.maxNewItemsPerRun) break;

    // Per-feed interval (falls back to the global default).
    const intervalMin = src.poll_interval_minutes || cfg.intervalMin;
    const slot = Math.floor(Date.now() / (intervalMin * 60 * 1000));

    // Atomic per-feed slot claim: only the first cron tick inside this slot wins.
    let claimed = false;
    try { claimed = await claimRssSlot(env, src.id, slot); } catch { claimed = false; }
    if (!claimed) { summary.feeds.push({ source: src.source_account, status: 0, fetched: 0, fresh: 0, enqueued: 0, error: 'slot_taken' }); continue; }

    try {
      const fetched = await fetchFeed(env, {
        feedUrl: src.feed_url,
        etag: src.etag,
        lastModified: src.last_modified,
        timeoutMs: cfg.feedTimeoutMs,
      });

      await updateSourceBookkeeping(env, src.id, {
        status: fetched.status, error: fetched.error,
        etag: fetched.etag, lastModified: fetched.lastModified,
        healthy: fetched.error === null,          // 304 (notModified) is healthy
        storeConditional: !cfg.probeOnly,         // probe must not poison live conditional headers
      });

      if (fetched.notModified || fetched.error || fetched.items.length === 0) {
        summary.feeds.push({
          source: src.source_account, status: fetched.status,
          fetched: fetched.items.length, fresh: 0, enqueued: 0,
          error: fetched.error, notModified: fetched.notModified,
        });
        continue;
      }

      const normalized = fetched.items
        .map(raw => normalizeRssItem(raw, { sourceAccount: src.source_account }))
        .filter((it): it is NormalizedItem => it !== null);
      runFetched += normalized.length;

      const freshBeforeCap = normalized.filter(
        it => src.last_seen_item_published_at == null || it.publishedAt > src.last_seen_item_published_at,
      ).length;
      const fresh = filterNewByWatermark(normalized, src.last_seen_item_published_at, cfg.maxItemsPerFeed);
      const droppedByCap = Math.max(0, freshBeforeCap - fresh.length);

      if (cfg.probeOnly) {
        const latest = fresh[0] ?? normalized[0];
        console.log('[RSSIngest][probe]', {
          source: src.source_account, status: fetched.status, contentType: fetched.contentType,
          items: normalized.length, latestTitle: latest?.text?.slice(0, 80),
          latestUrl: latest?.sourceUrl, hasImage: (latest?.media?.length ?? 0) > 0,
          hasFullText: Boolean(latest?.fullText),
        });
        summary.feeds.push({ source: src.source_account, status: fetched.status, fetched: normalized.length, fresh: fresh.length, enqueued: 0, probe: true });
        continue;
      }

      // Per-feed enqueue, respecting run + day caps, with dedupe idempotency.
      // News-first: items older than the cap window are intentionally dropped and
      // logged (droppedByCap); the watermark advances past them below.
      const toEnqueue: Array<{ item: NormalizedItem; keys: string[] }> = [];
      for (const item of fresh) {
        if (cfg.maxNewItemsPerRun > 0 && runEnqueued + toEnqueue.length >= cfg.maxNewItemsPerRun) break;
        if (cfg.maxNewItemsPerDay > 0 && dayCount + toEnqueue.length >= cfg.maxNewItemsPerDay) break;
        const keys = computeDedupeKeys(item);
        if (await isDuplicate(env, keys)) continue;
        toEnqueue.push({ item, keys });
      }

      let inserted = 0;
      let duplicateExisting = 0;
      if (toEnqueue.length > 0) {
        if (!runCreated) {
          runCategoryId = src.category_id;
          await env.DB.prepare(
            `INSERT OR IGNORE INTO discovery_runs (id, category_id, platform, apify_dataset_id, status) VALUES (?, ?, 'rss', 'rss', 'processing')`,
          ).bind(runId, src.category_id).run();
          runCreated = true;
        }

        const enqueueResults = await enqueueCandidates(env, toEnqueue.map(({ item, keys }) => ({
          sourceId: src.id,
          runId,
          categoryId: src.category_id,
          platform: 'rss',
          sourceAccount: item.sourceAccount,
          sourceUrl: item.sourceUrl,
          postId: item.postId,
          publishedAt: item.publishedAt,
          normalizedItem: item,
          dedupeKeys: keys,
          priorityScore: item.publishedAt,
        })));
        // Count only rows actually inserted — INSERT OR IGNORE no-ops on the
        // candidate-queue unique source_url index for an already-queued article.
        inserted = enqueueResults.filter(r => r.inserted).length;
        duplicateExisting = enqueueResults.length - inserted;
        // dedupe_keys are recorded by backlog-drain at persist time (from
        // dedupe_keys_json), so a transient brief failure doesn't permanently
        // dedup the article.
      }

      // News-first watermark: advance past every fresh item we considered this
      // run (enqueued, duplicate, or cap-dropped) so old backlog is not re-scanned.
      if (fresh.length > 0) await advanceWatermark(env, src.id, fresh);
      if (droppedByCap > 0) {
        console.log('[RSSIngest] cap drop (news-first):', { source: src.source_account, droppedByCap, cap: cfg.maxItemsPerFeed });
      }

      runEnqueued += inserted;
      dayCount += inserted;
      runDuplicate += duplicateExisting;
      summary.feeds.push({
        source: src.source_account, status: fetched.status,
        fetched: normalized.length, fresh: fresh.length,
        enqueued: inserted, duplicate: duplicateExisting, droppedByCap,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[RSSIngest] feed ${src.source_account} failed:`, msg);
      summary.feeds.push({ source: src.source_account, status: 0, fetched: 0, fresh: 0, enqueued: 0, error: msg.slice(0, 160) });
    }
  }

  // Finalize the RSS discovery_run so it does not linger in 'processing'.
  if (runCreated) {
    try {
      await env.DB.prepare(`
        UPDATE discovery_runs
        SET status = 'completed', items_fetched = ?, items_new = ?, items_duplicate = ?, category_id = ?
        WHERE id = ?
      `).bind(runFetched, runEnqueued, runDuplicate, runCategoryId, runId).run();
    } catch (err) {
      console.warn('[RSSIngest] run finalize failed:', err instanceof Error ? err.message : String(err));
    }
  }

  summary.totalEnqueued = runEnqueued;
  return summary;
}
