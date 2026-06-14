import { describe, expect, it, vi } from 'vitest';
import {
  claimCandidateBatch,
  fetchPendingCandidates,
  recoverStaleScoringCandidates,
  releaseClaimedCandidatesToPending,
} from '../apps/worker-api/src/services/candidate-queue';
import type { AICandidateRow, Env } from '../apps/worker-api/src/types';

function envWithPrepare(prepare: ReturnType<typeof vi.fn>): Env {
  return {
    DB: { prepare } as unknown as D1Database,
    AI_CANDIDATE_MAX_ATTEMPTS: '2',
    AI_CANDIDATE_MAX_AGE_HOURS: '6',
  } as unknown as Env;
}

function row(overrides: Partial<AICandidateRow> = {}): AICandidateRow {
  return {
    id: 'cand_1',
    source_id: 'src',
    run_id: 'run',
    category_id: 'crypto',
    platform: 'x',
    source_account: 'cointelegraph',
    source_url: 'https://x.com/cointelegraph/status/1',
    post_id: '1',
    published_at: 1000,
    normalized_item_json: '{}',
    dedupe_keys_json: '[]',
    priority_score: 0,
    status: 'pending',
    attempt_count: 0,
    last_error: null,
    created_at: new Date().toISOString(),
    claimed_at: null,
    scored_at: null,
    ...overrides,
  };
}

describe('candidate-queue phase 2 safety', () => {
  it('filters pending candidates by max attempts before returning rows', async () => {
    let capturedSql = '';
    const prepare = vi.fn((sql: string) => {
      capturedSql = sql;
      return {
        bind: vi.fn(() => ({ all: vi.fn(async () => ({ results: [row()] })) })),
        all: vi.fn(async () => ({ results: [row()] })),
      };
    });

    const rows = await fetchPendingCandidates(envWithPrepare(prepare), 10);

    expect(rows).toHaveLength(1);
    expect(capturedSql).toContain('attempt_count <');
  });

  it('claims candidates with optimistic locking and increments attempt_count once', async () => {
    let capturedSql = '';
    const prepare = vi.fn((sql: string) => {
      capturedSql = sql;
      return {
        bind: vi.fn(() => ({ run: vi.fn(async () => ({ meta: { changes: 1 } })) })),
      };
    });

    const claimed = await claimCandidateBatch(envWithPrepare(prepare), [row({ attempt_count: 1 })]);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.status).toBe('scoring');
    expect(claimed[0]!.attempt_count).toBe(2);
    // v4.1: claim now also reclaims needs_translation candidates for translation retry
    expect(capturedSql).toContain("status IN ('pending', 'needs_translation')");
    expect(capturedSql).toContain('attempt_count <');
  });

  it('can release claimed candidates back to pending and roll back attempt consumption for budget stops', async () => {
    const captured: Array<{ sql: string; args: unknown[] }> = [];
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn((...args: unknown[]) => {
        captured.push({ sql, args });
        return { run: vi.fn(async () => ({ meta: { changes: 1 } })) };
      }),
    }));

    await releaseClaimedCandidatesToPending(envWithPrepare(prepare), ['cand_1'], 'AI_MAX_CALLS_PER_DAY reached', { decrementAttempt: true });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toContain("status='pending'");
    expect(captured[0]!.sql).toContain('attempt_count=CASE');
    expect(captured[0]!.args).toContain(1);
  });

  it('recovers stale scoring candidates below max attempts and fails stale maxed-out candidates', async () => {
    const sqls: string[] = [];
    let call = 0;
    const prepare = vi.fn((sql: string) => {
      sqls.push(sql);
      return {
        bind: vi.fn(() => ({
          run: vi.fn(async () => ({ meta: { changes: call++ === 0 ? 3 : 2 } })),
        })),
      };
    });

    const result = await recoverStaleScoringCandidates(envWithPrepare(prepare), 15);

    expect(result).toEqual({ recovered: 3, failed: 2 });
    expect(sqls[0]).toContain("status='pending'");
    expect(sqls[0]).toContain('attempt_count <');
    expect(sqls[1]).toContain("status='failed'");
    expect(sqls[1]).toContain('attempt_count >=');
  });
});
