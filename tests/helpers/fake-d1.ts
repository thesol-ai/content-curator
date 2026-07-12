// Lightweight D1-compatible database for integration tests, backed by the real
// SQLite engine built into Node 22 (node:sqlite). It loads the project's actual
// migrations, so stateful pipeline logic (claims, watermarks, run_events,
// counters) is exercised against real SQL instead of mocks.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function normalizeParam(p: unknown): unknown {
  if (p === undefined) return null;
  if (typeof p === 'boolean') return p ? 1 : 0;
  return p;
}

class FakeStatement {
  private params: unknown[] = [];
  constructor(private db: DatabaseSync, private sql: string) {}

  bind(...params: unknown[]): FakeStatement {
    this.params = params.map(normalizeParam);
    return this;
  }

  async run(): Promise<{ success: boolean; meta: { changes: number; last_row_id: number } }> {
    const r = this.db.prepare(this.sql).run(...(this.params as any));
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }

  async first<T = any>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...(this.params as any));
    return (row ?? null) as T | null;
  }

  async all<T = any>(): Promise<{ results: T[]; success: boolean }> {
    const rows = this.db.prepare(this.sql).all(...(this.params as any));
    return { results: rows as T[], success: true };
  }
}

export class FakeD1 {
  constructor(private db: DatabaseSync) {}
  prepare(sql: string): FakeStatement {
    return new FakeStatement(this.db, sql);
  }

  async batch(
    statements: FakeStatement[],
  ): Promise<Array<{
    success: boolean;
    meta: {
      changes: number;
      last_row_id: number;
    };
  }>> {
    this.db.exec('BEGIN IMMEDIATE');

    try {
      const results = [];

      for (const statement of statements) {
        results.push(await statement.run());
      }

      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Direct access for test setup/assertions (not part of the D1 surface). */
  exec(sql: string): void { this.db.exec(sql); }
  get<T = any>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...(params.map(normalizeParam) as any)) as T | undefined;
  }
  rows<T = any>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params.map(normalizeParam) as any)) as T[];
  }
}

/** Create an in-memory D1-like DB with all project migrations applied. */
export function makeTestDb(): FakeD1 {
  const db = new DatabaseSync(':memory:');
  const dir = join(process.cwd(), 'migrations');
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(dir, f), 'utf8'));
  }
  return new FakeD1(db);
}
