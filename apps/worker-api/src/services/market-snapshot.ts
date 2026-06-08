import type { Env, ChannelRow } from '../types';
import { publishToTelegram } from './telegram-publisher';

interface CoinConfig {
  symbol: string;
  binanceSymbol: string;
}

interface MarketSnapshotData {
  generatedAt: number;
  lines: string[];
  totalMarketCapUsd?: number;
  btcDominance?: number;
}

const COINS: CoinConfig[] = [
  { symbol: 'BTC', binanceSymbol: 'BTCUSDT' },
  { symbol: 'ETH', binanceSymbol: 'ETHUSDT' },
  { symbol: 'SOL', binanceSymbol: 'SOLUSDT' },
  { symbol: 'XRP', binanceSymbol: 'XRPUSDT' },
  { symbol: 'BNB', binanceSymbol: 'BNBUSDT' },
  { symbol: 'ADA', binanceSymbol: 'ADAUSDT' },
  { symbol: 'TON', binanceSymbol: 'TONUSDT' },
  { symbol: 'DOGE', binanceSymbol: 'DOGEUSDT' },
];

type TelegramEntity = {
  type: 'custom_emoji' | 'text_link';
  offset: number;
  length: number;
  custom_emoji_id?: string;
  url?: string;
};

const MARKET_SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'ADA', 'TON', 'DOGE'] as const;
type MarketSymbol = typeof MARKET_SYMBOLS[number];


const SNAPSHOT_SOURCE_URL = 'https://www.binance.com/en/markets';
const DEFAULT_CHANNEL_ID = 'crypto_fa_pilot';
const CACHE_KEY = 'market_snapshot_cache_v2';
const CACHE_TTL_SECONDS = 15 * 60;
const STALE_CACHE_TTL_SECONDS = 2 * 60 * 60;

export async function buildMarketSnapshotText(env: Env): Promise<string> {
  const data = await getMarketSnapshotData(env);

  const body = [
    '📊 نمای بازار کریپتو',
    '',
    ...data.lines,
  ];

  body.push('');
  body.push(`🌐 ارزش کل بازار: ${formatUsdCompact(data.totalMarketCapUsd)}`);
  body.push(`سهم بیت‌کوین: ${formatPercent(data.btcDominance)}`);

  return body.join('\n').trim();
}

export async function sendMarketSnapshotDirect(
  env: Env,
  channelId = getMarketSnapshotChannelId(env),
  force = false
): Promise<{
  ok: boolean;
  sent: boolean;
  skipped?: boolean;
  reason?: string;
  slotKey: string;
  messageId?: string;
  error?: string;
  text?: string;
}> {
  const channel = await loadChannel(env, channelId);
  if (!channel) throw new Error(`Channel not found: ${channelId}`);
  if (!isEnabled(channel.enabled) || !isEnabled(channel.publish_enabled)) {
    return { ok: true, sent: false, skipped: true, reason: 'channel_disabled', slotKey: currentMarketSlotKey(channel.timezone) };
  }

  const slotKey = currentMarketSlotKey(channel.timezone || 'Asia/Tehran');
  const sentKey = marketSentKey(channel.id, slotKey);

  if (!force) {
    const alreadySent = await env.DB
      .prepare('SELECT value FROM settings WHERE key=? LIMIT 1')
      .bind(sentKey)
      .first<{ value: string }>();

    if (alreadySent) {
      return { ok: true, sent: false, skipped: true, reason: 'already_sent_for_slot', slotKey };
    }
  }

  const text = await buildMarketSnapshotText(env);

  const result = await sendMarketSnapshotTelegram(env, channel, text);

  if (!result.ok) {
    return {
      ok: false,
      sent: false,
      slotKey,
      error: result.error || 'telegram_publish_failed',
      text,
    };
  }

  await env.DB
    .prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value=excluded.value,
        updated_at=CURRENT_TIMESTAMP
    `)
    .bind(sentKey, JSON.stringify({ sentAt: Math.floor(Date.now() / 1000), messageId: result.messageId ?? null }))
    .run();

  return {
    ok: true,
    sent: true,
    slotKey,
    messageId: result.messageId,
    text,
  };
}

export async function maybeSendMarketSnapshotDirect(env: Env): Promise<{
  shouldRun: boolean;
  sent?: boolean;
  skipped?: boolean;
  reason?: string;
  slotKey?: string;
  messageId?: string;
  error?: string;
}> {
  if (!isMarketSnapshotEnabled(env)) {
    return { shouldRun: false, reason: 'market_snapshot_disabled' };
  }

  const channelId = getMarketSnapshotChannelId(env);
  const channel = await loadChannel(env, channelId);
  const timezone = channel?.timezone || 'Asia/Tehran';
  const parts = tehranDateParts(new Date(), timezone);
  const intervalHours = getMarketSnapshotIntervalHours(env);

  if (parts.minute !== 0) {
    return { shouldRun: false, reason: `not_top_of_hour_minute_${parts.minute}` };
  }

  if (parts.hour % intervalHours !== 0) {
    return { shouldRun: false, reason: `not_interval_hour_${parts.hour}_mod_${intervalHours}` };
  }

  const result = await sendMarketSnapshotDirect(env, channelId, false);

  return {
    shouldRun: true,
    sent: result.sent,
    skipped: result.skipped,
    reason: result.reason,
    slotKey: result.slotKey,
    messageId: result.messageId,
    error: result.error,
  };
}

function isMarketSnapshotEnabled(env: Env): boolean {
  return String(env.MARKET_SNAPSHOT_ENABLED ?? 'false').toLowerCase() === 'true';
}

function getMarketSnapshotIntervalHours(env: Env): number {
  const raw = Number(env.MARKET_SNAPSHOT_INTERVAL_HOURS ?? '1');
  if (!Number.isFinite(raw)) return 1;
  const n = Math.floor(raw);
  if (n < 1) return 1;
  if (n > 24) return 24;
  return n;
}

function getMarketSnapshotChannelId(env: Env): string {
  return String(env.MARKET_SNAPSHOT_CHANNEL_ID || DEFAULT_CHANNEL_ID).trim() || DEFAULT_CHANNEL_ID;
}

async function sendMarketSnapshotTelegram(
  env: Env,
  channel: ChannelRow,
  bodyText: string
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  if (isCustomEmojiEnabled(env)) {
    return sendMarketSnapshotTelegramWithEntities(env, channel, bodyText);
  }

  const result = await publishToTelegram(env, {
    chatId: channel.telegram_chat_id,
    captionShort: bodyText,
    captionFull: bodyText,
    sourceUrl: SNAPSHOT_SOURCE_URL,
    method: 'sendMessage',
    language: channel.language || 'fa',
    channel,
    mediaUrls: [],
    mediaTypes: [],
  });

  return {
    ok: result.ok,
    messageId: result.messageId,
    error: result.error,
  };
}

async function sendMarketSnapshotTelegramWithEntities(
  env: Env,
  channel: ChannelRow,
  bodyText: string
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not configured' };

  const emojiMap = getCustomEmojiMap(env);
  const built = buildMarketSnapshotTextWithEntities(bodyText, emojiMap, channel);

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: channel.telegram_chat_id,
      text: built.text,
      entities: built.entities,
      link_preview_options: { is_disabled: true },
    }),
  });

  const json: any = await res.json().catch(() => null);

  if (!res.ok || json?.ok !== true) {
    return {
      ok: false,
      error: json?.description || `Telegram sendMessage failed: ${res.status}`,
    };
  }

  return {
    ok: true,
    messageId: String(json?.result?.message_id ?? ''),
  };
}

function buildMarketSnapshotTextWithEntities(
  bodyText: string,
  emojiMap: Partial<Record<MarketSymbol, { id: string; fallback: string }>>,
  channel: ChannelRow
): { text: string; entities: TelegramEntity[] } {
  const lines = bodyText.split('\n');
  const outputLines: string[] = [];
  const entities: TelegramEntity[] = [];

  for (const line of lines) {
    const symbolMatch = line.match(/^(BTC|ETH|SOL|XRP|BNB|ADA|TON|DOGE):\s/);
    if (!symbolMatch) {
      outputLines.push(line);
      continue;
    }

    const symbol = symbolMatch[1] as MarketSymbol;
    const customEmoji = emojiMap[symbol];

    if (!customEmoji) {
      outputLines.push(line);
      continue;
    }

    const placeholder = customEmoji.fallback;
    const prefix = `${placeholder} `;
    const lineStartOffset = utf16Length(outputLines.join('\n')) + (outputLines.length > 0 ? 1 : 0);

    outputLines.push(`${prefix}${line}`);

    entities.push({
      type: 'custom_emoji',
      offset: lineStartOffset,
      length: utf16Length(placeholder),
      custom_emoji_id: customEmoji.id,
    });
  }

  if (isEnabled(channel.source_enabled)) {
    outputLines.push('');

    const sourcePrefix = '🌏 ';
    const sourceLabel = 'Source';
    const sourceLine = `${sourcePrefix}${sourceLabel}`;
    const sourceLineStart = utf16Length(outputLines.join('\n')) + (outputLines.length > 0 ? 1 : 0);

    outputLines.push(sourceLine);

    entities.push({
      type: 'text_link',
      offset: sourceLineStart + utf16Length(sourcePrefix),
      length: utf16Length(sourceLabel),
      url: SNAPSHOT_SOURCE_URL,
    });
  }

  if (isEnabled(channel.channel_id_footer_enabled)) {
    const footer = String(channel.channel_id_footer_text || '').trim();
    if (footer) outputLines.push(footer);
  }

  return {
    text: outputLines.join('\n').trim(),
    entities,
  };
}

function isCustomEmojiEnabled(env: Env): boolean {
  return String(env.MARKET_SNAPSHOT_CUSTOM_EMOJIS_ENABLED ?? 'false').toLowerCase() === 'true';
}

function getCustomEmojiMap(env: Env): Partial<Record<MarketSymbol, { id: string; fallback: string }>> {
  return {
    BTC: customEmoji(cleanEmojiId(env.MARKET_SNAPSHOT_EMOJI_BTC), '🥇'),
    ETH: customEmoji(cleanEmojiId(env.MARKET_SNAPSHOT_EMOJI_ETH), '💩'),
    SOL: customEmoji(cleanEmojiId(env.MARKET_SNAPSHOT_EMOJI_SOL), '💀'),
    XRP: customEmoji(cleanEmojiId(env.MARKET_SNAPSHOT_EMOJI_XRP), '👤'),
    BNB: customEmoji(cleanEmojiId(env.MARKET_SNAPSHOT_EMOJI_BNB), '🌧'),
    ADA: customEmoji(cleanEmojiId(env.MARKET_SNAPSHOT_EMOJI_ADA), '😭'),
    TON: customEmoji(cleanEmojiId(env.MARKET_SNAPSHOT_EMOJI_TON), '🌽'),
    DOGE: customEmoji(cleanEmojiId(env.MARKET_SNAPSHOT_EMOJI_DOGE), '🐶'),
  };
}

function customEmoji(id: string | undefined, fallback: string): { id: string; fallback: string } | undefined {
  return id ? { id, fallback } : undefined;
}

function cleanEmojiId(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  return text || undefined;
}

function utf16Length(value: string): number {
  return [...value].reduce((length, char) => length + (char.codePointAt(0)! > 0xffff ? 2 : 1), 0);
}

async function getMarketSnapshotData(env: Env): Promise<MarketSnapshotData> {
  const now = Math.floor(Date.now() / 1000);
  const cached = await readCachedSnapshot(env);

  if (cached && now - cached.cachedAt <= CACHE_TTL_SECONDS) {
    return cached.data;
  }

  try {
    const fresh = await fetchMarketSnapshotData();
    await writeCachedSnapshot(env, fresh);
    return fresh;
  } catch (error) {
    if (cached && now - cached.cachedAt <= STALE_CACHE_TTL_SECONDS) {
      console.warn('[MarketSnapshot] Using stale cached data after fetch failure:', error instanceof Error ? error.message : String(error));
      return cached.data;
    }

    throw error;
  }
}

async function fetchMarketSnapshotData(): Promise<MarketSnapshotData> {
  const [priceData, globalData] = await Promise.all([
    fetchBinancePrices(),
    fetchCoinGeckoGlobalOptional(),
  ]);

  return {
    generatedAt: Math.floor(Date.now() / 1000),
    lines: priceData,
    totalMarketCapUsd: globalData.totalMarketCapUsd,
    btcDominance: globalData.btcDominance,
  };
}

async function fetchBinancePrices(): Promise<string[]> {
  const symbols = encodeURIComponent(JSON.stringify(COINS.map((coin) => coin.binanceSymbol)));
  const url = `https://api.binance.com/api/v3/ticker/24hr?symbols=${symbols}`;

  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'content-curator/market-snapshot' },
  });

  if (!res.ok) throw new Error(`Binance price error: ${res.status}`);

  const rows = await res.json<any[]>();
  const bySymbol = new Map<string, any>();
  for (const row of rows) bySymbol.set(String(row.symbol), row);

  return COINS.map((coin) => {
    const row = bySymbol.get(coin.binanceSymbol);
    const price = Number(row?.lastPrice);
    const change = Number(row?.priceChangePercent);
    return formatMarketLine(coin.symbol, price, change);
  });
}

async function fetchCoinGeckoGlobalOptional(): Promise<{ totalMarketCapUsd?: number; btcDominance?: number }> {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/global', {
      headers: { accept: 'application/json', 'user-agent': 'content-curator/market-snapshot' },
    });

    if (!res.ok) {
      console.warn(`[MarketSnapshot] CoinGecko global skipped: ${res.status}`);
      return {};
    }

    const global = await res.json<any>();
    return {
      totalMarketCapUsd: Number(global?.data?.total_market_cap?.usd),
      btcDominance: Number(global?.data?.market_cap_percentage?.btc),
    };
  } catch (error) {
    console.warn('[MarketSnapshot] CoinGecko global failed:', error instanceof Error ? error.message : String(error));
    return {};
  }
}

async function readCachedSnapshot(env: Env): Promise<{ cachedAt: number; data: MarketSnapshotData } | null> {
  const row = await env.DB
    .prepare('SELECT value FROM settings WHERE key=? LIMIT 1')
    .bind(CACHE_KEY)
    .first<{ value: string }>();

  if (!row?.value) return null;

  try {
    const parsed = JSON.parse(row.value);
    if (!Number.isFinite(Number(parsed.cachedAt))) return null;
    if (!parsed.data || !Array.isArray(parsed.data.lines)) return null;
    return {
      cachedAt: Number(parsed.cachedAt),
      data: parsed.data as MarketSnapshotData,
    };
  } catch {
    return null;
  }
}

async function writeCachedSnapshot(env: Env, data: MarketSnapshotData): Promise<void> {
  const payload = JSON.stringify({
    cachedAt: Math.floor(Date.now() / 1000),
    data,
  });

  await env.DB
    .prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value=excluded.value,
        updated_at=CURRENT_TIMESTAMP
    `)
    .bind(CACHE_KEY, payload)
    .run();
}

async function loadChannel(env: Env, channelId: string): Promise<ChannelRow | null> {
  const row = await env.DB
    .prepare('SELECT * FROM channels WHERE id=? LIMIT 1')
    .bind(channelId)
    .first<ChannelRow>();
  return row ?? null;
}

function isEnabled(value: unknown): boolean {
  if (value === false || value === 0 || value === '0') return false;
  if (typeof value === 'string' && value.toLowerCase() === 'false') return false;
  return true;
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$—';
  if (value >= 1000) return `$${Math.round(value).toLocaleString('en-US')}`;
  if (value >= 1) return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
}

function formatUsdCompact(value?: number): string {
  if (!Number.isFinite(value)) return '$—';
  const n = Number(value);
  if (n >= 1_000_000_000_000) return `$${(n / 1_000_000_000_000).toFixed(2)}T`;
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function formatMarketLine(symbol: string, price: number, change: number): string {
  const symbolText = symbol.padEnd(5, ' ');
  const priceText = formatUsd(price).padEnd(9, ' ');

  if (!Number.isFinite(change)) {
    return `⚪ ${symbolText}${priceText} (• —)`;
  }

  if (change < 0) {
    return `🔴 ${symbolText}${priceText} (▼ ${Math.abs(change).toFixed(1)}%)`;
  }

  if (change > 0) {
    return `🟢 ${symbolText}${priceText} (▲ ${change.toFixed(1)}%)`;
  }

  return `⚪ ${symbolText}${priceText} (• 0.0%)`;
}

function formatSignedPercent(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

function formatPercent(value?: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${Number(value).toFixed(1)}%`;
}

function formatTehranTime(unixSec: number): string {
  return new Intl.DateTimeFormat('fa-IR-u-nu-latn', {
    timeZone: 'Asia/Tehran',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(unixSec * 1000));
}

function currentMarketSlotKey(timezone: string): string {
  const parts = tehranDateParts(new Date(), timezone || 'Asia/Tehran');
  return `${parts.year}${parts.month}${parts.day}_${String(parts.hour).padStart(2, '0')}00`;
}

function tehranDateParts(date: Date, timezone: string): { year: string; month: string; day: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  };
}

function marketSentKey(channelId: string, slotKey: string): string {
  return `market_snapshot_sent_${channelId}_${slotKey}`;
}

function stableHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `market_${(h >>> 0).toString(16)}`;
}
