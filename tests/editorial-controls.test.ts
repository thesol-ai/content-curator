import { describe, expect, it, vi } from 'vitest';
import { handleAdmin } from '../apps/worker-api/src/routes/admin';
import { buildTranslationSystem, type TranslationTarget } from '../apps/worker-api/src/services/ai-gate';
import type { CategoryRow, Env } from '../apps/worker-api/src/types';

function request(path: string, method: string, body?: unknown): Request {
  return new Request(`https://worker.test${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function envWithCapturedDb() {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((...values: unknown[]) => ({
        run: vi.fn(async () => {
          calls.push({ sql, values });
          return { meta: { changes: 1 } };
        }),
        all: vi.fn(async () => ({ results: [] })),
        first: vi.fn(async () => ({ n: 0 })),
      })),
      run: vi.fn(async () => ({ meta: { changes: 1 } })),
      all: vi.fn(async () => ({ results: [] })),
      first: vi.fn(async () => ({ n: 0 })),
    })),
  };
  return { env: { DB: db } as unknown as Env, calls };
}

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
    editorial_guidelines: 'Introduce central people briefly and write like a Telegram news/education post.',
    selection_criteria: 'Prefer standalone posts with clear crypto relevance.',
    rejection_criteria: 'Reject reply-only posts without context.',
    required_context: 'Vitalik Buterin = Ethereum co-founder.',
    avoid_duplicate_people_stories: 1,
    enabled: 1,
    ...overrides,
  };
}

function target(overrides: Partial<TranslationTarget> = {}): TranslationTarget {
  return {
    key: 'channel:crypto_fa',
    language: 'fa',
    label: 'Crypto FA',
    toneProfile: 'neutral',
    customInstructions: 'Avoid literal tweet translation.',
    channelId: 'crypto_fa',
    editorialMode: 'news',
    audienceLevel: 'intermediate',
    captionStyle: 'contextual',
    creativityLevel: 0.2,
    captionMaxChars: 900,
    captionShortMaxChars: 240,
    languagePrompt: 'فارسی روان و خبری، نه ترجمه تحت‌اللفظی.',
    terminologyNotes: 'stablecoin = استیبل‌کوین; liquidation = لیکوئید شدن',
    forbiddenPhrases: ['در پستی جدید', 'در پاسخ به کاربری دیگر'],
    ...overrides,
  };
}

describe('editorial prompt controls', () => {
  it('stores category-level editorial controls', async () => {
    const { env, calls } = envWithCapturedDb();

    const res = await handleAdmin(request('/internal/categories', 'POST', {
      id: 'crypto',
      label: 'Crypto',
      prompt_profile: 'crypto_editorial',
      editorial_guidelines: 'Write as news/education, not raw tweet translation.',
      selection_criteria: 'Standalone and useful for crypto audience.',
      rejection_criteria: 'Reject reply without context.',
      required_context: 'Vitalik = Ethereum co-founder.',
      avoid_duplicate_people_stories: false,
    }), env, {} as ExecutionContext);

    expect(res.status).toBe(200);
    expect(calls[0].sql).toContain('editorial_guidelines');
    expect(calls[0].sql).toContain('selection_criteria');
    expect(calls[0].values).toContain('Write as news/education, not raw tweet translation.');
    expect(calls[0].values).toContain('Reject reply without context.');
    expect(calls[0].values).toContain(0);
  });

  it('stores channel/language editorial controls', async () => {
    const { env, calls } = envWithCapturedDb();

    const res = await handleAdmin(request('/internal/channels/crypto_fa', 'PATCH', {
      editorial_mode: 'educational',
      audience_level: 'beginner',
      caption_style: 'educational_summary',
      creativity_level: 0.4,
      caption_max_chars: 900,
      caption_short_max_chars: 220,
      language_prompt: 'فارسی روان و خبری بنویس.',
      terminology_notes: 'DeFi = دیفای',
      forbidden_phrases: ['در پستی جدید', 'در پاسخ به کاربری دیگر'],
    }), env, {} as ExecutionContext);

    expect(res.status).toBe(200);
    expect(calls[0].sql).toContain('editorial_mode=?');
    expect(calls[0].sql).toContain('caption_max_chars=?');
    expect(calls[0].values).toContain('educational');
    expect(calls[0].values).toContain(0.4);
    expect(calls[0].values).toContain(900);
    expect(calls[0].values).toContain(JSON.stringify(['در پستی جدید', 'در پاسخ به کاربری دیگر']));
  });

  it('builds translation prompt with editorial controls and no raw source URL requirement', () => {
    const system = buildTranslationSystem([target()], category());

    expect(system).toContain('Do NOT include source URLs or raw links');
    expect(system).toContain('فارسی روان و خبری');
    expect(system).toContain('forbidden_phrases');
    expect(system).toContain('در پستی جدید');
    expect(system).toContain('Vitalik Buterin = Ethereum co-founder');
    expect(system).toContain('caption_full":"≤900 chars');
    expect(system).not.toContain('Include source URL at the end');
  });
});
