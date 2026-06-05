import { describe, expect, it } from 'vitest';
import { recordRunEvent, recordRunItemEvent, sanitizeRunDebugId } from '../apps/worker-api/src/services/run-events';
import { handleAdmin } from '../apps/worker-api/src/routes/admin';

describe('run events service', () => {
  it('records run and item events as best-effort DB inserts', async () => {
    const executed: Array<{ sql: string; args: unknown[] }> = [];

    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            run: async () => {
              executed.push({ sql, args });
              return { meta: { changes: 1 } };
            },
          }),
        }),
      },
    } as any;

    await recordRunEvent(env, {
      runId: 'run_test',
      eventType: 'phase.changed',
      phase: 'ai_gate',
      severity: 'info',
      metadata: { hello: 'world' },
    });

    await recordRunItemEvent(env, {
      runId: 'run_test',
      itemId: 'item_test',
      phase: 'persist_ai_results',
      status: 'queue_created',
      aiScore: 88,
    });

    expect(executed).toHaveLength(2);
    expect(executed[0]!.sql).toContain('INSERT INTO run_events');
    expect(executed[1]!.sql).toContain('INSERT INTO run_item_events');
  });

  it('does not throw when event logging insert fails', async () => {
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            run: async () => {
              throw new Error('db unavailable');
            },
          }),
        }),
      },
    } as any;

    await expect(recordRunEvent(env, {
      runId: 'run_test',
      eventType: 'test',
      phase: 'test',
    })).resolves.toBeUndefined();

    await expect(recordRunItemEvent(env, {
      runId: 'run_test',
      phase: 'test',
      status: 'test',
    })).resolves.toBeUndefined();
  });

  it('sanitizes run ids for debug routes', () => {
    expect(sanitizeRunDebugId('run_abc-123')).toBe('run_abc-123');
    expect(sanitizeRunDebugId('bad/value')).toBeNull();
    expect(sanitizeRunDebugId('')).toBeNull();
  });
});

describe('run event debug endpoints', () => {
  it('lists run events through read-only admin endpoint', async () => {
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            all: async () => ({
              results: [{
                id: 'evt_1',
                run_id: args[0],
                event_type: 'phase.changed',
                phase: 'ai_gate',
                severity: 'info',
                created_at: '2026-06-05 00:00:00',
              }],
            }),
          }),
        }),
      },
    } as any;

    const res = await handleAdmin(
      new Request('http://localhost/internal/debug/runs/run_abc/events?limit=10'),
      env,
      {} as ExecutionContext,
    );

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(body.read_only).toBe(true);
    expect(body.run_id).toBe('run_abc');
    expect(body.events).toHaveLength(1);
  });

  it('rejects invalid run ids in event debug endpoints', async () => {
    const env = { DB: { prepare: () => ({}) } } as any;

    const res = await handleAdmin(
      new Request('http://localhost/internal/debug/runs/bad.value/events'),
      env,
      {} as ExecutionContext,
    );

    expect(res.status).toBe(400);
  });
});
