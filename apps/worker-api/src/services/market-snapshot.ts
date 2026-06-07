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
];

const SNAPSHOT_SOURCE_URL = 'https://www.binance.com/en/markets';
const DEFAULT_CHANNEL_ID = 'crypto_fa_pilot';
const CACHE_KEY = 'market_snapshot_cache_v2';
const CACHE_TTL_SECONDS = 15 * 60;
const STALE_CACHE_TTL_SECONDS = 2 * 60 * 60;

export async function buildMarketSnapshotText(env: Env): Promise<string> {
  const data = await getMarketSnapshotData(env);
  const tehranTime = formatTehranTime(data.generatedAt);

  const body = [
    `📊 نمای بازار کریپتو | ${tehranTime}`,
    '',
    ...data.lines,
  ];

  if (Number.isFinite(data.totalMarketCapUsd) || Number.isFinite(data.btcDominance)) {
    body.push('');
    body.push(`ارزش کل بازار: ${formatUsdCompact(data.totalMarketCapUsd)}`);
    body.push(`سهم بیت‌کوین: ${formatPercent(data.btcDominance)}`);
  }

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

  const result = await publishToTelegram(env, {
    chatId: channel.telegram_chat_id,
    captionShort: text,
    captionFull: text,
    sourceUrl: SNAPSHOT_SOURCE_URL,
    method: 'sendMessage',
    language: channel.language || 'fa',
    channel,
    mediaUrls: [],
    mediaTypes: [],
  });

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
    return `${coin.symbol}: ${formatUsd(price)} (${formatSignedPercent(change)})`;
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
