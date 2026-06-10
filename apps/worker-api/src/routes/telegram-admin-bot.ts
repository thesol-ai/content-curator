import type { Env } from '../types';
import { buildOperationalReport } from '../services/operational-report';
import {
  formatOperationalReportForTelegram,
  normalizeOperationalReportSection,
  type OperationalReportSection,
} from '../services/report-message-formatter';

type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type TelegramMessage = {
  message_id?: number;
  text?: string;
  chat?: { id?: number | string; type?: string };
  from?: { id?: number; username?: string; first_name?: string };
};

type TelegramCallbackQuery = {
  id?: string;
  data?: string;
  message?: TelegramMessage;
  from?: { id?: number; username?: string; first_name?: string };
};

export async function handleTelegramAdminBot(req: Request, env: Env): Promise<Response> {
  if (env.TELEGRAM_ADMIN_BOT_ENABLED !== 'true') {
    return Response.json({ ok: false, error: 'telegram_admin_bot_disabled' }, { status: 404 });
  }

  if (req.method !== 'POST') {
    return Response.json({ ok: false, error: 'method_not_allowed' }, { status: 405 });
  }

  if (!verifyTelegramAdminSecret(req, env)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const update = await req.json().catch(() => null) as TelegramUpdate | null;
  if (!update || typeof update !== 'object') {
    return Response.json({ ok: false, error: 'invalid_update' }, { status: 400 });
  }

  const actorId = getActorId(update);
  const chatId = getChatId(update);

  if (!chatId) {
    return Response.json({ ok: true, ignored: true, reason: 'missing_chat_id' });
  }

  if (!isAllowedAdminUser(actorId, env)) {
    console.warn(`[TelegramAdminBot] unauthorized user_id=${actorId ?? 'unknown'}`);
    await sendTelegramMessage(env, chatId, buildUnauthorizedText(actorId), undefined);
    return Response.json({ ok: true, ignored: true, reason: 'user_not_allowed', user_id: actorId ?? null });
  }

  if (update.callback_query?.id) {
    await answerCallbackQuery(env, update.callback_query.id);
  }

  const text = update.message?.text?.trim() ?? '';
  const callbackData = update.callback_query?.data?.trim() ?? '';
  const callbackMessageId = update.callback_query?.message?.message_id;

  if (text === '/start' || text === '/menu' || callbackData === 'menu') {
    await replyOrEdit(env, chatId, callbackMessageId, buildMenuText(), mainMenuKeyboard());
    return Response.json({ ok: true, handled: 'menu' });
  }

  if (text === '/report' || text === '/ops' || callbackData === 'report:menu') {
    await sendReportSection(env, chatId, callbackMessageId, 'overview');
    return Response.json({ ok: true, handled: 'report:overview' });
  }

  if (callbackData.startsWith('report:')) {
    const section = normalizeOperationalReportSection(callbackData.slice('report:'.length));
    await sendReportSection(env, chatId, callbackMessageId, section);
    return Response.json({ ok: true, handled: `report:${section}` });
  }

  await replyOrEdit(env, chatId, callbackMessageId, buildMenuText(), mainMenuKeyboard());
  return Response.json({ ok: true, handled: 'fallback_menu' });
}

async function sendReportSection(
  env: Env,
  chatId: string | number,
  messageId: number | undefined,
  section: OperationalReportSection,
): Promise<void> {
  const reportUrl = new URL('https://telegram-admin.local/internal/report/ops?category=crypto');
  const report = await buildOperationalReport(env, reportUrl);
  const text = formatOperationalReportForTelegram(report as any, section);
  await replyOrEdit(env, chatId, messageId, text, reportSectionKeyboard(section));
}

function buildUnauthorizedText(userId: number | null): string {
  return [
    '⛔️ <b>دسترسی مجاز نیست</b>',
    '',
    'این bot فقط برای ادمین‌های ثبت‌شده فعال است.',
    '',
    `user_id شما: <code>${userId ?? 'unknown'}</code>`,
    '',
    'این عدد باید در TELEGRAM_ADMIN_ALLOWED_USER_IDS اضافه شود.',
  ].join('\n');
}

function buildMenuText(): string {
  return [
    '🛠 <b>پنل مدیریت محتوا</b>',
    '',
    'گزارش‌ها دسته‌بندی شده‌اند. هر بخش فقط همان اطلاعات خودش را نشان می‌دهد.',
    '',
    'یک بخش را انتخاب کن:',
  ].join('\n');
}

function mainMenuKeyboard(): object {
  return {
    inline_keyboard: [
      [{ text: '📊 گزارش‌ها', callback_data: 'report:menu' }],
    ],
  };
}

function reportSectionKeyboard(active: OperationalReportSection): object {
  const label = (section: OperationalReportSection, text: string) =>
    section === active ? `● ${text}` : text;

  return {
    inline_keyboard: [
      [
        { text: label('overview', '📌 خلاصه'), callback_data: 'report:overview' },
        { text: label('costs', '💵 هزینه‌ها'), callback_data: 'report:costs' },
      ],
      [
        { text: label('pipeline', '🔁 قیف محتوا'), callback_data: 'report:pipeline' },
        { text: label('publish', '📬 صف انتشار'), callback_data: 'report:publish' },
      ],
      [
        { text: label('apify', '🕷 Apify'), callback_data: 'report:apify' },
        { text: label('health', '⚠️ سلامت'), callback_data: 'report:health' },
      ],
      [
        { text: label('sources', '🏷 منابع'), callback_data: 'report:sources' },
      ],
      [
        { text: '🏠 منو', callback_data: 'menu' },
      ],
    ],
  };
}

async function replyOrEdit(
  env: Env,
  chatId: string | number,
  messageId: number | undefined,
  text: string,
  replyMarkup?: object,
): Promise<void> {
  if (messageId) {
    await editTelegramMessage(env, chatId, messageId, text, replyMarkup);
    return;
  }

  await sendTelegramMessage(env, chatId, text, replyMarkup);
}

async function sendTelegramMessage(
  env: Env,
  chatId: string | number,
  text: string,
  replyMarkup?: object,
): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not configured');

  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };

  if (replyMarkup) payload.reply_markup = replyMarkup;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram sendMessage failed ${res.status}: ${body.slice(0, 300)}`);
  }
}

async function editTelegramMessage(
  env: Env,
  chatId: string | number,
  messageId: number,
  text: string,
  replyMarkup?: object,
): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not configured');

  const payload: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };

  if (replyMarkup) payload.reply_markup = replyMarkup;

  const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (body.includes('message is not modified')) return;
    throw new Error(`Telegram editMessageText failed ${res.status}: ${body.slice(0, 300)}`);
  }
}

async function answerCallbackQuery(env: Env, callbackQueryId: string): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return;

  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  }).catch(() => undefined);
}

function verifyTelegramAdminSecret(req: Request, env: Env): boolean {
  const expected = env.TELEGRAM_ADMIN_BOT_SECRET?.trim();
  if (!expected) return env.ENVIRONMENT === 'local';

  const provided =
    req.headers.get('X-Telegram-Bot-Api-Secret-Token') ??
    req.headers.get('x-telegram-bot-api-secret-token') ??
    new URL(req.url).searchParams.get('secret');

  return provided === expected;
}

function isAllowedAdminUser(userId: number | null, env: Env): boolean {
  const raw = env.TELEGRAM_ADMIN_ALLOWED_USER_IDS?.trim();
  if (!raw) return env.ENVIRONMENT === 'local';
  if (!userId) return false;

  const allowed = raw
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);

  return allowed.includes(String(userId));
}

function getActorId(update: TelegramUpdate): number | null {
  return update.callback_query?.from?.id ?? update.message?.from?.id ?? null;
}

function getChatId(update: TelegramUpdate): string | number | null {
  const chatId = update.callback_query?.message?.chat?.id ?? update.message?.chat?.id;
  return chatId ?? null;
}
