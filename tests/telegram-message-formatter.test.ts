import { describe, expect, it } from 'vitest';
import type { ChannelRow } from '../apps/worker-api/src/types';
import {
  buildSourceLink,
  formatTelegramMessage,
  removeRawSourceReferences,
  resolveChannelFooter,
  sourceLabel,
  stabilizeRtlNumbersForTelegram,
} from '../apps/worker-api/src/services/telegram-message-formatter';

function channel(overrides: Partial<ChannelRow> = {}): ChannelRow {
  return {
    id: 'crypto_fa',
    category_id: 'crypto',
    telegram_chat_id: '@thesolxcrypto_fa',
    language: 'fa',
    timezone: 'Asia/Tehran',
    allowed_windows: '[]',
    blocked_windows: '[]',
    max_per_day: 5,
    max_per_hour: 1,
    min_gap_minutes: 90,
    publish_enabled: 1,
    enabled: 1,
    custom_instructions: null,
    tone_profile: 'neutral',
    channel_label: null,
    source_enabled: 1,
    source_label_override: null,
    signature_enabled: 0,
    signature_text: null,
    channel_id_footer_enabled: 0,
    channel_id_footer_text: null,
    disable_link_preview: 1,
    semantic_dedupe_enabled: 1,
    semantic_dedupe_window_hours: 24,
    max_posts_per_source_per_day: null,
    ...overrides,
  };
}

describe('telegram-message-formatter', () => {
  it('stabilizes decimal and percent numbers inside Persian Telegram captions', () => {
    const result = formatTelegramMessage({
      body: 'بیت‌کوین ۲.۵ درصد رشد کرد و حجم معاملات به ۸۱.۷ میلیون دلار رسید.',
      sourceUrl: 'https://x.com/example/status/1',
      language: 'fa',
      channel: channel({ source_enabled: 0 }),
      maxLength: 4096,
    });

    expect(result.html).toContain('\u2066۲.۵\u2069 درصد');
    expect(result.html).toContain('\u2066۸۱.۷\u2069 میلیون');
  });

  it('does not add numeric direction controls to English captions', () => {
    expect(stabilizeRtlNumbersForTelegram('BTC rose 2.5%', 'en')).toBe('BTC rose 2.5%');
  });

  it('omits source completely when source is disabled but keeps body text', () => {
    const sourceUrl = 'https://x.com/VitalikButerin/status/123';
    const result = formatTelegramMessage({
      body: `خبر اصلی\n\nSource: ${sourceUrl}`,
      sourceUrl,
      language: 'fa',
      channel: channel({ source_enabled: 0 }),
      maxLength: 4096,
    });

    expect(result.html).toContain('خبر اصلی');
    expect(result.html).not.toContain(sourceUrl);
    expect(result.html).not.toContain('<a href=');
    expect(result.footerIncluded).toBe(false);
  });

  it('shows localized Persian source label as a link without raw URL', () => {
    const sourceUrl = 'https://x.com/VitalikButerin/status/123';
    const result = formatTelegramMessage({
      body: 'ویتالیک درباره استیبل‌کوین‌ها توضیح داد.',
      sourceUrl,
      language: 'fa',
      channel: channel(),
      maxLength: 4096,
    });

    expect(result.html).toContain(`<a href="${sourceUrl}">منبع</a>`);
    expect(result.html).not.toContain(` ${sourceUrl}`);
    expect(result.footerIncluded).toBe(true);
  });

  it('shows English source label for English channels', () => {
    const result = formatTelegramMessage({
      body: 'A useful market update.',
      sourceUrl: 'https://example.com/post',
      language: 'en',
      channel: channel({ language: 'en' }),
      maxLength: 4096,
    });

    expect(result.html).toContain('>Source</a>');
  });

  it('uses source label override and escapes the label', () => {
    const result = formatTelegramMessage({
      body: 'متن خبر',
      sourceUrl: 'https://example.com/post',
      language: 'fa',
      channel: channel({ source_label_override: 'اصل <خبر>' }),
      maxLength: 4096,
    });

    expect(result.html).toContain('اصل &lt;خبر&gt;');
    expect(result.html).not.toContain('اصل <خبر>');
  });

  it('appends escaped signature and default channel footer in order', () => {
    const result = formatTelegramMessage({
      body: 'متن خبر',
      sourceUrl: 'https://example.com/post',
      language: 'fa',
      channel: channel({
        signature_enabled: 1,
        signature_text: '— The <Sol> Crypto',
        channel_id_footer_enabled: 1,
      }),
      maxLength: 4096,
    });

    expect(result.html).toContain('متن خبر\n\n<a href="https://example.com/post">منبع</a>\n— The &lt;Sol&gt; Crypto\n@thesolxcrypto_fa');
    expect(result.html).not.toContain('\u200F');
    expect(result.html).not.toContain('\n\u200F<a href="https://example.com/post">منبع</a>');
    expect(result.html).not.toContain('\n\u200F@thesolxcrypto_fa');
  });

  it('keeps source and channel footer adjacent without an empty line', () => {
    const result = formatTelegramMessage({
      body: 'متن خبر',
      sourceUrl: 'https://example.com/post',
      language: 'en',
      channel: channel({
        source_label_override: '🌏 Source',
        channel_id_footer_enabled: 1,
        channel_id_footer_text: '@thesolcrypto_fa',
      }),
      maxLength: 4096,
    });

    expect(result.html).toContain('متن خبر\n\n🌏 <a href="https://example.com/post">Source</a>\n@thesolcrypto_fa');
    expect(result.html).not.toContain('Source</a>\n\n@thesolcrypto_fa');
  });

  it('uses custom channel footer and omits numeric chat id without custom text', () => {
    expect(resolveChannelFooter(channel({
      telegram_chat_id: '-100123456',
      channel_id_footer_enabled: 1,
    }))).toBeNull();

    expect(resolveChannelFooter(channel({
      telegram_chat_id: '-100123456',
      channel_id_footer_enabled: 1,
      channel_id_footer_text: '@public_alias',
    }))).toBe('@public_alias');
  });

  it('escapes body HTML instead of trusting AI-provided tags', () => {
    const result = formatTelegramMessage({
      body: 'Hello <b>world</b> & friends',
      sourceUrl: undefined,
      language: 'en',
      channel: channel({ source_enabled: 0 }),
      maxLength: 4096,
    });

    expect(result.html).toBe('Hello &lt;b&gt;world&lt;/b&gt; &amp; friends');
  });

  it('does not generate links for unsafe source protocols', () => {
    const result = formatTelegramMessage({
      body: 'Unsafe source should not be linked.',
      sourceUrl: 'javascript:alert(1)',
      language: 'en',
      channel: channel(),
      maxLength: 4096,
    });

    expect(result.html).toBe('Unsafe source should not be linked.');
    expect(buildSourceLink('Source', 'javascript:alert(1)')).toBeNull();
  });

  it('removes raw source URL variants from AI body before adding source link', () => {
    const body = 'Update text\n\nمنبع: https://x.com/post/123/';
    const cleaned = removeRawSourceReferences(body, 'https://x.com/post/123');
    expect(cleaned).toBe('Update text');

    const result = formatTelegramMessage({
      body,
      sourceUrl: 'https://x.com/post/123',
      language: 'fa',
      channel: channel(),
      maxLength: 4096,
    });
    expect(result.html).not.toContain('https://x.com/post/123/');
    expect(result.html).toContain('<a href="https://x.com/post/123">منبع</a>');
  });

  it('truncates body while preserving the complete source footer', () => {
    const result = formatTelegramMessage({
      body: 'الف'.repeat(80),
      sourceUrl: 'https://example.com/post',
      language: 'fa',
      channel: channel(),
      maxLength: 70,
    });

    expect(result.truncated).toBe(true);
    expect(result.footerIncluded).toBe(true);
    expect(result.html).toContain('…');
    expect(result.html).toContain('<a href="https://example.com/post">منبع</a>');
    expect(result.html.length).toBeLessThanOrEqual(70);
  });

  it('omits footer atomically if the footer cannot fit', () => {
    const result = formatTelegramMessage({
      body: 'abcdefg',
      sourceUrl: 'https://example.com/very/long/source/path/that/will/not/fit',
      language: 'fa',
      channel: channel({ signature_enabled: 1, signature_text: 'signature' }),
      maxLength: 12,
    });

    expect(result.footerIncluded).toBe(false);
    expect(result.footerOmitted).toBe(true);
    expect(result.html).toBe('abcdefg');
    expect(result.html).not.toContain('\u200F');
    expect(result.html).not.toContain('<a href=');
  });

  it('does not cut escaped entities in half while truncating', () => {
    const result = formatTelegramMessage({
      body: 'A & B & C',
      sourceUrl: undefined,
      language: 'en',
      channel: channel({ source_enabled: 0 }),
      maxLength: 8,
    });

    expect(result.html).not.toMatch(/&(?:a|am|amp)$/);
    expect(result.html).toContain('…');
  });

  it('does not inject RTL marks into Persian messages because structured content can break', () => {
    const result = formatTelegramMessage({
      body: '🚀 Ondo Perps نسخه بتای عمومی خود را راه‌اندازی کرد.\nETF بیت‌کوین دوباره در مرکز توجه است.',
      sourceUrl: 'https://example.com/post',
      language: 'fa',
      channel: channel(),
      maxLength: 4096,
    });

    expect(result.html.charCodeAt(0)).not.toBe(8207);
    expect(result.html).toContain('🚀 Ondo Perps نسخه بتای عمومی خود را راه‌اندازی کرد.');
    expect(result.html).toContain('\nETF بیت‌کوین دوباره در مرکز توجه است.');
    expect(result.html).toContain('\n\n<a href="https://example.com/post">منبع</a>');
    expect(result.html).not.toContain('\u200F');
  });


  it('keeps the small standalone helpers stable', () => {
    expect(sourceLabel('fa')).toBe('منبع');
    expect(sourceLabel('en')).toBe('Source');
    expect(sourceLabel('de')).toBe('Source');
    expect(sourceLabel('fa', 'اصل خبر')).toBe('اصل خبر');
  });
});
