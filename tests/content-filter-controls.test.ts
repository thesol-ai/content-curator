import { describe, expect, it, vi } from 'vitest';
import { normalizeItem } from '../apps/worker-api/src/services/apify-client';
import { getItemRejectReason, getPreAiContentRejectReason } from '../apps/worker-api/src/services/curation-orchestrator';
import { handleAdmin } from '../apps/worker-api/src/routes/admin';
import type { AIGateResult, CategoryRow, Env, NormalizedItem } from '../apps/worker-api/src/types';

function category(overrides: Partial<CategoryRow> = {}): CategoryRow {
  return {
    id: 'crypto',
    label: 'Crypto',
    prompt_profile: 'crypto_editorial',
    custom_prompt: null,
    score_threshold: 75,
    freshness_hours: 24,
    media_mode: 'optional',
    language_targets: '["fa"]',
    editorial_guidelines: null,
    selection_criteria: null,
    rejection_criteria: null,
    required_context: null,
    avoid_duplicate_people_stories: 1,
    enabled: 1,
    ...overrides,
  };
}

function item(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    platform: 'x',
    sourceAccount: 'VitalikButerin',
    sourceUrl: 'https://x.com/VitalikButerin/status/123',
    postId: '123',
    publishedAt: Math.floor(Date.now() / 1000),
    text: 'A post about DeFi options and stablecoins.',
    media: [],
    engagementLikes: 10,
    engagementShares: 2,
    engagementViews: 100,
    mediaUrlExpiresSoon: false,
    ...overrides,
  };
}

function ai(overrides: Partial<AIGateResult> = {}): AIGateResult {
  return {
    publish: true,
    score: 80,
    riskLevel: 'low',
    riskFlags: [],
    topicFingerprint: 'defi-options',
    publishPriority: 'normal',
    translations: {},
    ...overrides,
  };
}

function request(path: string, method: string, body?: unknown): Request {
  return new Request(`https://worker.test${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('content filter controls', () => {
  it('normalizes X reply, retweet, and quote metadata from Apify/Twitter shapes', () => {
    const reply = normalizeItem({
      url: 'https://x.com/a/status/1',
      id: '1',
      text: 'reply text',
      author: { userName: 'a' },
      inReplyToStatusId: '0',
    }, 'x');
    expect(reply?.isReply).toBe(true);

    const retweet = normalizeItem({
      url: 'https://x.com/a/status/2',
      id: '2',
      text: 'rt text',
      author: { userName: 'a' },
      isRetweet: true,
    }, 'x');
    expect(retweet?.isRetweet).toBe(true);

    const quote = normalizeItem({
      url: 'https://x.com/a/status/3',
      id: '3',
      text: 'quote text',
      author: { userName: 'a' },
      quotedTweetId: '99',
    }, 'x');
    expect(quote?.isQuote).toBe(true);
  });

  it('rejects replies before AI when category replies are disabled by default', () => {
    expect(getPreAiContentRejectReason(item({ isReply: true }), category())).toBe('reply_not_allowed');
    expect(getPreAiContentRejectReason(item({ isReply: true }), category({ allow_replies: 1 }))).toBeNull();
  });

  it('rejects retweets, quotes, and text-only items according to category policy', () => {
    expect(getPreAiContentRejectReason(item({ isRetweet: true }), category({ allow_retweets: 0 }))).toBe('retweet_not_allowed');
    expect(getPreAiContentRejectReason(item({ isQuote: true }), category({ allow_quotes: 0 }))).toBe('quote_not_allowed');
    expect(getPreAiContentRejectReason(item({ media: [] }), category({ text_only_policy: 'reject' }))).toBe('text_only_rejected');
  });

  it('applies post-AI score floors for text-only and media items', () => {
    expect(getItemRejectReason(ai({ score: 84 }), category({ text_only_policy: 'penalize', min_score_for_text_only: 90 }), item({ media: [] }), false)).toBe('text_only_below_min_score');
    expect(getItemRejectReason(ai({ score: 84 }), category({ min_score_for_media: 90 }), item({ media: [{ type: 'image', url: 'https://example.com/a.jpg' }] }), false)).toBe('media_below_min_score');
  });

  it('stores category-level reply and media controls through the admin API', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...values: unknown[]) => ({
          run: vi.fn(async () => { calls.push({ sql, values }); return { meta: { changes: 1 } }; }),
          all: vi.fn(async () => ({ results: [] })),
          first: vi.fn(async () => null),
        })),
        run: vi.fn(async () => ({ meta: { changes: 1 } })),
        all: vi.fn(async () => ({ results: [] })),
        first: vi.fn(async () => null),
      })),
    };

    const res = await handleAdmin(request('/internal/categories', 'POST', {
      id: 'crypto',
      label: 'Crypto',
      prompt_profile: 'crypto_editorial',
      allow_replies: false,
      allow_retweets: false,
      allow_quotes: true,
      text_only_policy: 'penalize',
      min_score_for_text_only: 90,
      min_score_for_media: 70,
    }), { DB: db } as unknown as Env, {} as ExecutionContext);

    expect(res.status).toBe(200);
    const insert = calls.find(call => call.sql.includes('INSERT OR IGNORE INTO categories'));
    expect(insert?.values).toContain(0); // allow_replies or allow_retweets
    expect(insert?.values).toContain('penalize');
    expect(insert?.values).toContain(90);
    expect(insert?.values).toContain(70);
  });
});
