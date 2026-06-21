import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestDb, type FakeD1 } from './helpers/fake-d1';
import { runRssIngestion } from '../apps/worker-api/src/services/rss-ingestion';
import {
  claimCandidateBatch,
  fetchPendingCandidates,
  releaseClaimedCandidatesToPending,
} from '../apps/worker-api/src/services/candidate-queue';

function rssXml(items: Array<{ title: string; link: string; date?: string }>): string {
  const body = items.map(i => `<item><title>${i.title}</title><link>${i.link}</link>` +
    `<pubDate>${i.date ?? 'Sun, 21 Jun 2026 07:00:00 +0000'}</pubDate></item>`).join('');
  return `<?xml version="1.0"?><rss version="2.0"><channel>${body}</channel></rss>`;
}

function resp(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(status === 304 ? null : body, { status, headers });
}

function baseEnv(db: FakeD1): any {
  return {
    DB: db,
    RSS_INGEST_ENABLED: 'true',
    RSS_INGEST_INTERVAL_MIN: '30',
    RSS_MAX_ITEMS_PER_FEED: '4',
    RSS_MAX_NEW_ITEMS_PER_RUN: '50',
    RSS_MAX_NEW_ITEMS_PER_DAY: '200',
    RSS_FEED_TIMEOUT_SEC: '5',
  };
}

let db: FakeD1;
beforeEach(() => {
  db = makeTestDb();
  // Keep only one feed enabled for deterministic assertions.
  db.exec(`UPDATE rss_sources SET enabled = 0 WHERE id != 'rss_crypto_coindesk'`);
});
afterEach(() => vi.unstubAllGlobals());

describe('runRssIngestion (integration, real SQLite)', () => {
  it('enqueues new items and finalizes the discovery_run to completed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(200, rssXml([
      { title: 'Story A', link: 'https://www.coindesk.com/a' },
      { title: 'Story B', link: 'https://www.coindesk.com/b' },
    ]), { etag: 'v1' })));

    const summary = await runRssIngestion(baseEnv(db), { categoryId: 'crypto' });

    expect(summary.totalEnqueued).toBe(2);
    expect(db.get<{ c: number }>(`SELECT COUNT(*) c FROM ai_candidate_queue WHERE platform='rss'`)!.c).toBe(2);
    const run = db.get<{ status: string; items_new: number }>(`SELECT status, items_new FROM discovery_runs WHERE platform='rss'`);
    expect(run!.status).toBe('completed');
    expect(run!.items_new).toBe(2);
    // run_events recorded (not just console)
    expect(db.get<{ c: number }>(`SELECT COUNT(*) c FROM run_events WHERE event_type LIKE 'rss.%'`)!.c).toBeGreaterThan(0);
  });

  it('is idempotent: re-running the same slot does not double-enqueue', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(200, rssXml([{ title: 'A', link: 'https://www.coindesk.com/a' }]), { etag: 'v1' })));
    await runRssIngestion(baseEnv(db), { categoryId: 'crypto' });
    const second = await runRssIngestion(baseEnv(db), { categoryId: 'crypto' });
    // Same 30-min slot is already claimed → feed skipped, nothing new.
    expect(second.totalEnqueued).toBe(0);
    expect(db.get<{ c: number }>(`SELECT COUNT(*) c FROM ai_candidate_queue WHERE platform='rss'`)!.c).toBe(1);
    // The slot-taken second run must NOT create an empty discovery_run.
    expect(db.get<{ c: number }>(`SELECT COUNT(*) c FROM discovery_runs WHERE platform='rss'`)!.c).toBe(1);
  });

  it('probe-only does not enqueue, does not store ETag, but is observable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(200, rssXml([{ title: 'A', link: 'https://www.coindesk.com/a' }]), { etag: 'v1' })));
    const env = { ...baseEnv(db), RSS_FEED_PROBE_ONLY: 'true' };
    await runRssIngestion(env, { categoryId: 'crypto' });

    expect(db.get<{ c: number }>(`SELECT COUNT(*) c FROM ai_candidate_queue`)!.c).toBe(0);
    // ETag must NOT be persisted in probe — else live ingestion would 304-stall.
    expect(db.get<{ etag: string | null }>(`SELECT etag FROM rss_sources WHERE id='rss_crypto_coindesk'`)!.etag).toBeNull();
    // But the probe IS observable.
    expect(db.get<{ c: number }>(`SELECT COUNT(*) c FROM discovery_runs WHERE apify_dataset_id='rss_probe'`)!.c).toBe(1);
    expect(db.get<{ c: number }>(`SELECT COUNT(*) c FROM run_events WHERE event_type='rss.feed.probe'`)!.c).toBe(1);
  });

  it('304 Not Modified is healthy: no consecutive_failures, no enqueue', async () => {
    db.exec(`UPDATE rss_sources SET consecutive_failures = 0, etag = 'v1' WHERE id='rss_crypto_coindesk'`);
    vi.stubGlobal('fetch', vi.fn(async () => resp(304, '', { etag: 'v1' })));
    await runRssIngestion(baseEnv(db), { categoryId: 'crypto' });

    const src = db.get<{ consecutive_failures: number; last_http_status: number }>(
      `SELECT consecutive_failures, last_http_status FROM rss_sources WHERE id='rss_crypto_coindesk'`);
    expect(src!.consecutive_failures).toBe(0);
    expect(src!.last_http_status).toBe(304);
    expect(db.get<{ c: number }>(`SELECT COUNT(*) c FROM ai_candidate_queue`)!.c).toBe(0);
  });

  it('HTTP 403 increments consecutive_failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(403, 'Forbidden')));
    await runRssIngestion(baseEnv(db), { categoryId: 'crypto' });
    const src = db.get<{ consecutive_failures: number; last_error: string }>(
      `SELECT consecutive_failures, last_error FROM rss_sources WHERE id='rss_crypto_coindesk'`);
    expect(src!.consecutive_failures).toBe(1);
    expect(src!.last_error).toBe('http_403');
  });
});

describe('cap-deferred release does not burn attempt_count (blocker fix)', () => {
  it('survives many defer cycles without ever reaching max-attempts/failed', async () => {
    const env = { DB: db, AI_CANDIDATE_MAX_ATTEMPTS: '2' } as any;
    db.exec(`
      INSERT INTO ai_candidate_queue (id, category_id, platform, source_url, normalized_item_json, dedupe_keys_json, status, attempt_count)
      VALUES ('cand1', 'crypto', 'rss', 'https://www.coindesk.com/a', '{}', '[]', 'pending', 0)
    `);

    // Each cycle mimics: claim (attempt++) → daily cap hit → release deferred
    // with decrementAttempt (attempt--). Over many cycles attempt_count must not
    // creep up to max (which would falsely fail a healthy article).
    for (let cycle = 0; cycle < 6; cycle++) {
      const pending = await fetchPendingCandidates(env, 10, 'crypto');
      expect(pending.length).toBe(1); // always re-fetchable (attempt_count < max)
      const claimed = await claimCandidateBatch(env, pending);
      expect(claimed.length).toBe(1);
      await releaseClaimedCandidatesToPending(env, ['cand1'], 'rss_brief_daily_cap', { decrementAttempt: true });
    }

    const row = db.get<{ status: string; attempt_count: number; last_error: string }>(
      `SELECT status, attempt_count, last_error FROM ai_candidate_queue WHERE id='cand1'`);
    expect(row!.status).toBe('pending');
    expect(row!.attempt_count).toBe(0);
    expect(row!.last_error).toBe('rss_brief_daily_cap');
  });
});
