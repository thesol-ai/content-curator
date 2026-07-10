import { describe, expect, it } from 'vitest';
import { buildTranslationSystem, type TranslationTarget } from '../apps/worker-api/src/services/ai-gate';
import { applyPersianCaptionQualityGuard, repairPersianCaptionText, scoreCaptionQuality } from '../apps/worker-api/src/services/story-quality-guard';
import type { CategoryRow, TranslationOutput } from '../apps/worker-api/src/types';

function category(id: string, overrides: Partial<CategoryRow> = {}): CategoryRow {
  return {
    id,
    label: id === 'crypto' ? 'Crypto' : 'Finance',
    prompt_profile: id === 'crypto' ? 'crypto_editorial' : 'finance_editorial',
    custom_prompt: null,
    score_threshold: 75,
    freshness_hours: 24,
    media_mode: 'optional',
    language_targets: '["fa"]',
    editorial_guidelines: 'Write a clear Telegram post for the target audience.',
    selection_criteria: 'Prefer standalone useful news.',
    rejection_criteria: 'Reject vague hype.',
    required_context: 'Explain hard terms briefly when needed.',
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
    customInstructions: '',
    channelId: 'crypto_fa',
    editorialMode: 'news',
    audienceLevel: 'intermediate',
    captionStyle: 'contextual',
    creativityLevel: 0.2,
    captionMaxChars: 900,
    captionShortMaxChars: 260,
    languagePrompt: 'فارسی روان، روشن و قابل فهم برای کاربران کریپتو.',
    terminologyNotes: '',
    forbiddenPhrases: [],
    ...overrides,
  };
}

function translation(captionShort: string, captionFull = captionShort): TranslationOutput {
  return { captionShort, captionFull, hashtags: [] };
}

describe('crypto Persian caption writing quality', () => {
  it('adds crypto-only caption guidance without overriding other category prompts', () => {
    const cryptoSystem = buildTranslationSystem([target()], category('crypto'));
    const financeSystem = buildTranslationSystem([target()], category('finance'));

    expect(cryptoSystem).toContain('Crypto Persian caption writing mode');
    expect(cryptoSystem).toContain('mixed skill levels');
    expect(cryptoSystem).toContain('TVL = پولی که داخل پروتکل‌های دیفای قفل شده');
    expect(cryptoSystem).toContain('caption_short should usually be 1-2 sentences');
    expect(cryptoSystem).toContain('Use exactly one relevant formal emoji at the start');

    expect(financeSystem).not.toContain('Crypto Persian caption writing mode');
    expect(financeSystem).not.toContain('TVL = پولی که داخل پروتکل‌های دیفای قفل شده');
  });

  it('rejects Persian captions whose first real word is not Persian', () => {
    const result = applyPersianCaptionQualityGuard(
      'fa',
      translation('BTC دوباره به محدوده ۷۰ هزار دلار نزدیک شد.'),
      'BTC دوباره به محدوده ۷۰ هزار دلار نزدیک شد.',
      { rejectEnabled: true, repairEnabled: false, categoryId: 'crypto' },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('caption_non_persian_lead');
  });

  it('allows a sparse emoji when the first real word after it is Persian', () => {
    const result = applyPersianCaptionQualityGuard(
      'fa',
      translation('📊 بیت‌کوین دوباره به محدوده ۷۰ هزار دلار نزدیک شد.'),
      'بیت‌کوین دوباره به محدوده ۷۰ هزار دلار نزدیک شد.',
      { rejectEnabled: true, repairEnabled: false, categoryId: 'crypto' },
    );

    expect(result.ok).toBe(true);
  });

  it('rejects vague/formal crypto captions while leaving non-crypto categories to their own prompts', () => {
    const vague = translation(
      'حمایت بیش از ۶۰ مدیرعامل رمزارزی از قانون BRCA اهمیت ویژه‌ای دارد و به شفاف‌سازی چارچوب‌های قانونی کمک می‌کند.',
    );
    const source = 'More than 60 crypto CEOs backed BRCA. The bill covers blockchain and smart contracts.';

    const cryptoResult = applyPersianCaptionQualityGuard(
      'fa',
      vague,
      source,
      { rejectEnabled: true, repairEnabled: false, categoryId: 'crypto' },
    );
    expect(cryptoResult.ok).toBe(false);
    expect(cryptoResult.reason).toBe('caption_vague_or_formal');

    const financeResult = applyPersianCaptionQualityGuard(
      'fa',
      vague,
      source,
      { rejectEnabled: true, repairEnabled: false, categoryId: 'finance' },
    );
    expect(financeResult.ok).toBe(true);
  });

  it('scores vague crypto-style wording lower than clear explanatory wording', () => {
    const vagueScore = scoreCaptionQuality(
      'حمایت بیش از ۶۰ مدیرعامل رمزارزی از قانون BRCA اهمیت ویژه‌ای دارد و به شفاف‌سازی چارچوب‌های قانونی کمک می‌کند.',
      'More than 60 crypto CEOs backed BRCA.',
    );
    const clearScore = scoreCaptionQuality(
      'بیش از ۶۰ مدیرعامل کریپتو از قانون BRCA حمایت کرده‌اند. این قانون می‌خواهد قواعد فعالیت پروژه‌های بلاکچینی و قراردادهای هوشمند را روشن‌تر کند.',
      'More than 60 crypto CEOs backed BRCA. The bill covers blockchain and smart contracts.',
    );

    expect(vagueScore.vagueOrFormal).toBe(true);
    expect(clearScore.vagueOrFormal).toBe(false);
    expect(clearScore.score).toBeGreaterThan(vagueScore.score);
  });
  it('normalizes general Persian crypto caption spacing without broad word splitting', () => {
    const repaired = repairPersianCaptionText(
      'یک نهنگ ۲۳۴۱BTC معادل ۱۴۴.۶۸میلیوندلار برداشت کرد.همچنین ۷۳۷.۷USDT ثبت شد. این داده مرتبط،حاکیاز افزایش فعالیت است،اما بیت‌کوین و لایه‌دو نباید خراب شوند. اتریومETF هم نباید چسبیده بماند.'
    );

    expect(repaired).toContain('۲۳۴۱ BTC');
    expect(repaired).toContain('۱۴۴.۶۸ میلیون دلار');
    expect(repaired).toContain('۷۳۷.۷ USDT');
    expect(repaired).toContain('کرد. همچنین');
    expect(repaired).toContain('مرتبط، حاکی از');
    expect(repaired).toContain('است، اما');
    expect(repaired).toContain('اتریوم ETF');

    expect(repaired).toContain('بیت‌کوین');
    expect(repaired).toContain('لایه‌دو');

    expect(repaired).not.toContain('۲۳۴۱BTC');
    expect(repaired).not.toContain('میلیوندلار');
    expect(repaired).not.toContain('۷۳۷.۷USDT');
    expect(repaired).not.toContain('کرد.همچنین');
    expect(repaired).not.toContain('حاکیاز');
    expect(repaired).not.toContain('اتریومETF');
  });

});
