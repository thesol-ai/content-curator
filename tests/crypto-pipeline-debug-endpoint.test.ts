import { describe, expect, it } from 'vitest';
import { handleAdmin } from '../apps/worker-api/src/routes/admin';

function request(path: string): Request {
  return new Request(`http://localhost${path}`, { method: 'GET' });
}

function makeStmt(sql: string) {
  const all = async () => {
    if (sql.includes('FROM settings')) {
      return { results: [
        { key: 'apify_curation_enabled', value: 'false', updated_at: '2026-06-05 10:16:47' },
        { key: 'telegram_publish_enabled', value: 'false', updated_at: '2026-06-05 10:16:42' },
      ] };
    }
    if (sql.includes('GROUP BY status')) {
      return { results: [{ status: 'published', count: 16 }] };
    }
    if (sql.includes('FROM discovery_runs') && sql.includes("status='processing'")) {
      return { results: [{
        id: 'run_stuck',
        category_id: 'crypto',
        platform: 'x',
        apify_dataset_id: 'dataset_123',
        status: 'processing',
        items_fetched: 0,
        items_new: 0,
        items_duplicate: 0,
        items_ai_selected: 0,
        items_ai_rejected: 0,
        items_queued: 0,
        error_message: null,
        duration_ms: null,
        created_at: '2026-06-05 08:30:31',
        completed_at: null,
      }] };
    }
    if (sql.includes('FROM discovery_runs')) {
      return { results: [] };
    }
    if (sql.includes('FROM apify_sources')) {
      return { results: [] };
    }
    if (sql.includes('FROM ai_usage')) {
      return { results: [] };
    }
    if (sql.includes('FROM publish_queue')) {
      return { results: [] };
    }
    return { results: [] };
  };

  const first = async () => {
    if (sql.includes('FROM channels')) {
      return {
        id: 'crypto_fa_pilot',
        category_id: 'crypto',
        timezone: 'Asia/Tehran',
        publish_enabled: 1,
      };
    }
    return null;
  };

  return {
    bind: (..._args: unknown[]) => ({ all, first }),
    all,
    first,
  };
}

describe('crypto pipeline debug endpoint', () => {
  it('returns a read-only pipeline snapshot without triggering curation or publish', async () => {
    const env = {
      ENVIRONMENT: 'production',
      APIFY_CURATION_ENABLED: 'true',
      APIFY_CURATION_DRY_RUN: 'false',
      APIFY_SCHEDULED_CURATION_ENABLED: 'false',
      TELEGRAM_FINAL_PUBLISH_ENABLED: 'true',
      TELEGRAM_PUBLISH_SCHEDULER_ENABLED: 'true',
      DB: {
        prepare: (sql: string) => makeStmt(sql),
      },
    } as any;

    const res = await handleAdmin(
      request('/internal/debug/crypto-pipeline?category=crypto&channel=crypto_fa_pilot'),
      env,
      {} as ExecutionContext
    );

    expect(res.status).toBe(200);
    const body: any = await res.json();

    expect(body.ok).toBe(true);
    expect(body.read_only).toBe(true);
    expect(body.filters.category_id).toBe('crypto');
    expect(body.filters.channel_id).toBe('crypto_fa_pilot');
    expect(body.queue_counts.published).toBe(16);
    expect(body.stuck_runs).toHaveLength(1);
    expect(body.runtime_config.apify_scheduled_curation_enabled).toBe(false);
    expect(body.diagnosis).toContain('Telegram publishing is disabled by runtime setting.');
    expect(body.diagnosis).toContain('Apify curation is disabled by runtime setting; webhooks will not run AI/queue.');
  });

  it('sanitizes invalid debug filters back to safe defaults', async () => {
    const env = {
      ENVIRONMENT: 'production',
      APIFY_SCHEDULED_CURATION_ENABLED: 'false',
      DB: {
        prepare: (sql: string) => makeStmt(sql),
      },
    } as any;

    const res = await handleAdmin(
      request('/internal/debug/crypto-pipeline?category=crypto%27%3Bdrop&channel=bad/value'),
      env,
      {} as ExecutionContext
    );

    expect(res.status).toBe(200);
    const body: any = await res.json();

    expect(body.filters.category_id).toBe('crypto');
    expect(body.filters.channel_id).toBe('crypto_fa_pilot');
  });
});
