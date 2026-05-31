// ══════════════════════════════════════════════════════════════
// services/telegram-publisher.ts
// ارسال به Telegram Bot API — با fallback کامل
// ══════════════════════════════════════════════════════════════

import type { Env } from '../types';
import { buildMediaGroupPayload, detectMediaType } from './media-resolver';

export interface PublishInput {
  chatId: string;
  captionShort: string;    // ≤900 chars — برای روی media
  captionFull: string;     // ≤3500 chars — متن کامل
  sourceUrl: string;       // برای sendMessageWithLink
  method: string;          // telegram_method از queue
  mediaUrls: string[];
  mediaTypes?: Array<'image' | 'video'>;
}

export interface PublishResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

const TG_TIMEOUT_MS = 15_000;

// ── Main publish ──────────────────────────────────────────────

export async function publishToTelegram(
  env: Env,
  input: PublishInput
): Promise<PublishResult> {
  const publishEnabled =
    env.TELEGRAM_FINAL_PUBLISH_ENABLED === 'true' ||
    (await getSetting(env, 'telegram_publish_enabled')) === 'true';

  if (!publishEnabled) {
    return { ok: true, messageId: 'disabled_skip' };
  }

  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    return { ok: false, error: 'TELEGRAM_BOT_TOKEN not configured' };
  }

  const base = `https://api.telegram.org/bot${token}`;

  // اگر caption_full در محدوده Telegram بود از آن استفاده کن، وگرنه short
  const captionForMedia = input.captionFull.length <= 1024
    ? input.captionFull
    : input.captionShort.slice(0, 1024);

  try {
    switch (input.method) {

      case 'sendMessage':
        return callTg(base, 'sendMessage', {
          chat_id: input.chatId,
          text: input.captionFull.slice(0, 4096),
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: false },
        });

      case 'sendMessageWithLink': {
        const linkLine = input.sourceUrl
          ? `\n\n🔗 <a href="${escapeHtml(input.sourceUrl)}">منبع اصلی</a>`
          : '';
        return callTg(base, 'sendMessage', {
          chat_id: input.chatId,
          text: (input.captionFull + linkLine).slice(0, 4096),
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: false },
        });
      }

      case 'sendPhoto':
        return callTg(base, 'sendPhoto', {
          chat_id: input.chatId,
          photo: input.mediaUrls[0],
          caption: captionForMedia,
          parse_mode: 'HTML',
        });

      case 'sendVideo':
        return callTg(base, 'sendVideo', {
          chat_id: input.chatId,
          video: input.mediaUrls[0],
          caption: captionForMedia,
          parse_mode: 'HTML',
          supports_streaming: true,
        });

      case 'sendMediaGroup': {
        // تعیین type هر media item
        const types = input.mediaUrls.map((url, i) =>
          input.mediaTypes?.[i] ?? detectMediaType(url)
        );
        const mediaPayload = buildMediaGroupPayload(input.mediaUrls, types, input.captionShort);

        const result = await callTg(base, 'sendMediaGroup', {
          chat_id: input.chatId,
          media: mediaPayload,
        });

        // اگر caption_full بلندتر از 1024 بود، پیام جداگانه بفرست
        if (result.ok && input.captionFull.length > 1024) {
          await callTg(base, 'sendMessage', {
            chat_id: input.chatId,
            text: input.captionFull.slice(0, 4096),
            parse_mode: 'HTML',
          });
        }
        return result;
      }

      default:
        return { ok: false, error: `Unknown method: ${input.method}` };
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.slice(0, 500) };
  }
}

// ── Raw Telegram API call ─────────────────────────────────────

async function callTg(
  baseUrl: string,
  method: string,
  body: object
): Promise<PublishResult> {
  const res = await fetch(`${baseUrl}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TG_TIMEOUT_MS),
  });

  const data = await res.json() as any;

  if (!data.ok) {
    const raw = String(data.description ?? 'Telegram API error');
    // Redact token patterns from error messages
    const safe = raw.replace(/\bbot[A-Za-z0-9_-]{10,}:[A-Za-z0-9_-]{20,}\b/g, 'bot[REDACTED]');
    return { ok: false, error: safe.slice(0, 400) };
  }

  const result = data.result;
  const messageId = Array.isArray(result)
    ? String(result[0]?.message_id ?? '')
    : String(result?.message_id ?? '');

  return { ok: true, messageId };
}

// ── Helpers ───────────────────────────────────────────────────

async function getSetting(env: Env, key: string): Promise<string> {
  try {
    const row = await env.DB
      .prepare('SELECT value FROM settings WHERE key = ?')
      .bind(key)
      .first<{ value: string }>();
    return row?.value ?? '';
  } catch {
    return '';
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
