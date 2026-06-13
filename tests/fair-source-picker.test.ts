import { describe, expect, it } from 'vitest';
import {
  accountKey,
  selectCandidateBatchForScoring,
  selectFairFillBySourceAndAccount,
  sourceAccountBucketKey,
  sourceIdKey,
} from '../apps/worker-api/src/services/fair-source-picker';
import { getFairSourcePickerPoolMultiplier } from '../apps/worker-api/src/services/candidate-queue';
import type { AICandidateRow, Env } from '../apps/worker-api/src/types';

function candidate(
  id: string,
  sourceId: string | null,
  sourceAccount: string | null,
  priorityScore = 100,
): AICandidateRow {
  return {
    id,
    source_id: sourceId,
    run_id: `run_${id}`,
    category_id: 'crypto',
    platform: 'x',
    source_account: sourceAccount,
    source_url: `https://x.com/${sourceAccount ?? 'unknown'}/status/${id}`,
    post_id: id,
    published_at: Math.floor(Date.now() / 1000),
    normalized_item_json: '{}',
    dedupe_keys_json: '[]',
    priority_score: priorityScore,
    status: 'pending',
    attempt_count: 0,
    last_error: null,
    created_at: '2026-06-13 00:00:00',
    claimed_at: null,
    scored_at: null,
  };
}

describe('fair source picker', () => {
  it('keeps existing priority/FIFO order when fair picker is disabled', () => {
    const rows = [
      candidate('wu1', 'src_news_text', 'WuBlockchain'),
      candidate('wu2', 'src_news_text', 'WuBlockchain'),
      candidate('sol1', 'src_market_media', 'solana'),
      candidate('desk1', 'src_market_text', 'CoinDesk'),
    ];

    const selection = selectCandidateBatchForScoring(rows, 3, false);

    expect(selection.selected.map(row => row.id)).toEqual(['wu1', 'wu2', 'sol1']);
    expect(selection.stats.enabled).toBe(false);
    expect(selection.stats.outputCount).toBe(3);
  });

  it('fair-fills across source/query buckets before allowing one source to dominate', () => {
    const rows = [
      candidate('news-wu-1', 'src_crypto_x_news_text', 'WuBlockchain'),
      candidate('news-wu-2', 'src_crypto_x_news_text', 'WuBlockchain'),
      candidate('news-wu-3', 'src_crypto_x_news_text', 'WuBlockchain'),
      candidate('market-sol-1', 'src_market_trending_x_media', 'solana'),
      candidate('market-sol-2', 'src_market_trending_x_media', 'solana'),
      candidate('desk-1', 'src_market_trending_x_text', 'CoinDesk'),
      candidate('desk-2', 'src_market_trending_x_text', 'CoinDesk'),
    ];

    const selected = selectFairFillBySourceAndAccount(rows, 6);

    expect(selected.map(row => row.id)).toEqual([
      'news-wu-1',
      'market-sol-1',
      'desk-1',
      'news-wu-2',
      'market-sol-2',
      'desk-2',
    ]);
  });

  it('round-robins source accounts inside the same source bucket', () => {
    const rows = [
      candidate('wu-1', 'src_crypto_x_news_text', 'WuBlockchain'),
      candidate('wu-2', 'src_crypto_x_news_text', 'WuBlockchain'),
      candidate('desk-1', 'src_crypto_x_news_text', 'CoinDesk'),
      candidate('watcher-1', 'src_crypto_x_news_text', 'WatcherGuru'),
      candidate('wu-3', 'src_crypto_x_news_text', 'WuBlockchain'),
    ];

    const selected = selectFairFillBySourceAndAccount(rows, 5);

    expect(selected.map(row => row.id)).toEqual(['wu-1', 'desk-1', 'watcher-1', 'wu-2', 'wu-3']);
  });

  it('preserves batch volume when only one source and one account has candidates', () => {
    const rows = Array.from({ length: 8 }, (_, i) => candidate(`wu-${i + 1}`, 'src_crypto_x_news_text', 'WuBlockchain'));

    const selected = selectFairFillBySourceAndAccount(rows, 6);

    expect(selected).toHaveLength(6);
    expect(selected.every(row => row.source_account === 'WuBlockchain')).toBe(true);
  });

  it('backfills from the dominant source after minority buckets are exhausted', () => {
    const rows = [
      candidate('wu-1', 'src_crypto_x_news_text', 'WuBlockchain'),
      candidate('wu-2', 'src_crypto_x_news_text', 'WuBlockchain'),
      candidate('wu-3', 'src_crypto_x_news_text', 'WuBlockchain'),
      candidate('wu-4', 'src_crypto_x_news_text', 'WuBlockchain'),
      candidate('sol-1', 'src_market_trending_x_media', 'solana'),
      candidate('desk-1', 'src_market_trending_x_text', 'CoinDesk'),
    ];

    const selected = selectFairFillBySourceAndAccount(rows, 5);

    expect(selected.map(row => row.id)).toEqual(['wu-1', 'sol-1', 'desk-1', 'wu-2', 'wu-3']);
    expect(selected).toHaveLength(5);
  });

  it('reports source/account/bucket distribution stats for operational debugging', () => {
    const rows = [
      candidate('wu-1', 'src_crypto_x_news_text', 'WuBlockchain'),
      candidate('wu-2', 'src_crypto_x_news_text', 'WuBlockchain'),
      candidate('sol-1', 'src_market_trending_x_media', 'solana'),
      candidate('unknown-1', null, null),
    ];

    const selection = selectCandidateBatchForScoring(rows, 4, true);

    expect(selection.stats.sourceIdCount).toBe(3);
    expect(selection.stats.accountCount).toBe(3);
    expect(selection.stats.unknownSourceIdCount).toBe(1);
    expect(selection.stats.unknownAccountCount).toBe(1);
    expect(selection.stats.selectedBySourceId.src_crypto_x_news_text).toBe(2);
    expect(selection.stats.selectedByAccount.wublockchain).toBe(2);
    expect(selection.stats.selectedByBucket['src_crypto_x_news_text::wublockchain']).toBe(2);
  });

  it('normalizes source, account, and bucket keys safely', () => {
    const known = candidate('known', 'src_crypto_x_news_text', '@WuBlockchain');
    const unknown = candidate('unknown', null, null);

    expect(sourceIdKey(known)).toBe('src_crypto_x_news_text');
    expect(accountKey(known)).toBe('@wublockchain');
    expect(sourceAccountBucketKey(known)).toBe('src_crypto_x_news_text::@wublockchain');

    expect(sourceIdKey(unknown)).toBe('__unknown_source__');
    expect(accountKey(unknown)).toBe('__unknown_account__');
    expect(sourceAccountBucketKey(unknown)).toBe('__unknown_source__::__unknown_account__');
  });
});

describe('fair source picker pool multiplier config', () => {
  function env(value?: string): Env {
    return { AI_FAIR_SOURCE_PICKER_POOL_MULTIPLIER: value } as unknown as Env;
  }

  it('defaults to a wider inspect pool without changing batch size', () => {
    expect(getFairSourcePickerPoolMultiplier(env())).toBe(6);
  });

  it('parses valid values', () => {
    expect(getFairSourcePickerPoolMultiplier(env('8'))).toBe(8);
  });

  it('falls back on invalid or non-positive values', () => {
    expect(getFairSourcePickerPoolMultiplier(env('0'))).toBe(6);
    expect(getFairSourcePickerPoolMultiplier(env('-1'))).toBe(6);
    expect(getFairSourcePickerPoolMultiplier(env('abc'))).toBe(6);
  });

  it('clamps very large values to protect D1 reads', () => {
    expect(getFairSourcePickerPoolMultiplier(env('200'))).toBe(20);
  });
});
