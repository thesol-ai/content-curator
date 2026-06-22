import { describe, expect, it } from 'vitest';
import { formatTelegramMessage } from '../apps/worker-api/src/services/telegram-message-formatter';

const channel: any = {
  source_enabled: 0,
  signature_enabled: 0,
  channel_id_footer_enabled: 0,
};

describe('formatTelegramMessage title rendering', () => {
  it('renders Persian first-line title as bold and forces a period', () => {
    const res = formatTelegramMessage({
      body: '📌 بانک مرکزی انگلیس محدودیت استیبل‌کوین را کاهش داد\\n\\nمتن اصلی خبر اینجا شروع می‌شود و از تیتر جدا است.',
      sourceUrl: 'https://example.com',
      language: 'fa',
      channel,
      maxLength: 4096,
    });

    expect(res.html).toContain('<b>📌 بانک مرکزی انگلیس محدودیت استیبل‌کوین را کاهش داد.</b>\\n\\nمتن اصلی خبر');
  });

  it('does not duplicate the title period', () => {
    const res = formatTelegramMessage({
      body: '📌 بیت‌کوین دوباره به محدوده حساس رسید.\\n\\nمتن اصلی خبر جدا از تیتر می‌آید.',
      sourceUrl: 'https://example.com',
      language: 'fa',
      channel,
      maxLength: 4096,
    });

    expect(res.html).toContain('<b>📌 بیت‌کوین دوباره به محدوده حساس رسید.</b>');
    expect(res.html).not.toContain('رسید..');
  });
});
