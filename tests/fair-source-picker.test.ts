import { describe, expect, it } from 'vitest';
import {
  accountKey,
  selectCandidateBatchForScoring,
  selectRoundRobinBySourceAccount,
} from '../apps/worker-api/src/services/fair-source-picker';
import type { AICandidateRow } from '../apps/worker-api/src/types';

function row(id: string, sourceAccount: string | null): AICandidateRow {
  return {
    id,
    source_id: 'src',
    run_id: 'run',
    category_id: 'crypto',
    platform: 'x',
    source_account: sourceAccount,
    source_url: `https://x.com/${sourceAccount ?? 'unknown'}/status/${id}`,
    post_id: id,
    published_at: 1780000000,
    normalized_item_json: '{}',
    dedupe_keys_json: '[]',
    priority_score: 0,
    status: 'pending',
    attempt_count: 0,
    last_error: null,
    created_at: '2026-06-08T00:00:00Z',
    claimed_at: null,
    scored_at: null,
  };
}

describe('fair-source-picker', () => {
  it('keeps FIFO order when fair picker is disabled', () => {
    const candidates = [row('1', 'cointelegraph'), row('2', 'cointelegraph'), row('3', 'coindesk')];
    const result = selectCandidateBatchForScoring(candidates, 2, false);

    expect(result.selected.map(x => x.id)).toEqual(['1', '2']);
    expect(result.stats.enabled).toBe(false);
  });

  it('round-robins candidates across source accounts when enabled', () => {
    const candidates = [
      row('ct1', 'cointelegraph'),
      row('ct2', 'cointelegraph'),
      row('ct3', 'cointelegraph'),
      row('cd1', 'coindesk'),
      row('bc1', 'beincrypto'),
      row('cd2', 'coindesk'),
    ];

    const selected = selectRoundRobinBySourceAccount(candidates, 5);

    expect(selected.map(x => x.id)).toEqual(['ct1', 'cd1', 'bc1', 'ct2', 'cd2']);
  });

  it('falls back to original order when all candidates have the same account', () => {
    const candidates = [row('1', 'cointelegraph'), row('2', 'cointelegraph'), row('3', 'cointelegraph')];

    expect(selectRoundRobinBySourceAccount(candidates, 2).map(x => x.id)).toEqual(['1', '2']);
  });

  it('handles missing source accounts as an unknown group without dropping candidates', () => {
    const candidates = [row('u1', null), row('ct1', 'cointelegraph'), row('u2', ''), row('cd1', 'coindesk')];
    const result = selectCandidateBatchForScoring(candidates, 4, true);

    expect(result.selected.map(x => x.id)).toEqual(['u1', 'ct1', 'u2', 'cd1']);
    expect(result.stats.unknownAccountCount).toBe(2);
    expect(result.stats.selectedByAccount.__unknown__).toBe(2);
  });

  it('normalizes source account keys case-insensitively', () => {
    expect(accountKey(row('1', 'CoinTelegraph'))).toBe('cointelegraph');
    expect(accountKey(row('2', '  CoinDesk  '))).toBe('coindesk');
  });

  it('does not exceed the requested limit', () => {
    const candidates = [row('1', 'a'), row('2', 'b'), row('3', 'c'), row('4', 'd')];

    expect(selectCandidateBatchForScoring(candidates, 3, true).selected).toHaveLength(3);
  });

  it('returns empty selection for zero or negative limits', () => {
    const candidates = [row('1', 'a')];

    expect(selectCandidateBatchForScoring(candidates, 0, true).selected).toEqual([]);
    expect(selectCandidateBatchForScoring(candidates, -5, true).selected).toEqual([]);
  });

  it('preserves all candidates when input count is below limit', () => {
    const candidates = [row('1', 'a'), row('2', 'a'), row('3', 'b')];

    expect(selectCandidateBatchForScoring(candidates, 10, true).selected.map(x => x.id)).toEqual(['1', '2', '3']);
  });

  it('reports selected counts by account', () => {
    const candidates = [row('1', 'a'), row('2', 'a'), row('3', 'b')];
    const result = selectCandidateBatchForScoring(candidates, 3, true);

    expect(result.stats.selectedByAccount).toEqual({ a: 2, b: 1 });
    expect(result.stats.accountCount).toBe(2);
  });
});
