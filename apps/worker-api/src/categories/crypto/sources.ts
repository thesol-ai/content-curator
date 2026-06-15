import type {
  ApifyRotationAttemptPlan,
  ApifyRotationMode,
  ApifyRotationPlan,
  ApifyRotationSourceRow,
  CategorySourceStrategy,
} from '../types';

export const CRYPTO_ROTATION_SOURCE_IDS = new Set([
  'src_crypto_x_news_media',
  'src_crypto_x_news_text',
  'src_crypto_x_voices_media',
  'src_crypto_x_voices_text',
  'src_market_trending_x_media',
  'src_market_trending_x_text',
  // IMPROVEMENT #2: discovery lanes (need matching apify_sources rows to fire).
  'src_crypto_x_discovery_latest',
  'src_crypto_x_discovery_top',
]);

const NEWS_COHORTS = [
  ['CoinDesk', 'Cointelegraph'],
  ['TheBlock__', 'WuBlockchain'],
  ['decryptmedia', 'BitcoinMagazine'],
  ['DefiantNews', 'DLNewsInfo'],
  ['WatcherGuru', 'News_Of_Alpha'],
];

const VOICES_COHORTS = [
  ['EricBalchunas', 'JSeyff', 'NateGeraci', 'EleanorTerrett'],
  ['lookonchain', 'glassnode', 'cryptoquant_com'],
  ['Pentosh1', 'CryptoCred', 'CryptoHayes', 'RaoulGMI'],
  ['DefiLlama', 'BanklessHQ', 'TheDefiantNews'],
  ['VitalikButerin', 'ethereum'],
  ['solana', 'base', 'chainlink'],
  ['CoinbaseAssets', 'binance'],
  ['WatcherGuru', 'Tree_of_Alpha', 'News_Of_Alpha'],
];

const SECURITY_ALERT_COHORTS = [
  ['zachxbt', 'PeckShieldAlert', 'SlowMist_Team', 'CyversAlerts'],
];

const TOKEN_PROJECT_COHORTS = [
  ['CoinbaseAssets', 'binance', 'WatcherGuru', 'News_Of_Alpha'],
  ['ethereum', 'solana', 'base', 'chainlink'],
  ['DefiLlama', 'BanklessHQ', 'TheDefiantNews', 'Tree_of_Alpha'],
];

const MARKET_IMPACT_TEXT_COHORTS = [
  ['EricBalchunas', 'JSeyff', 'NateGeraci', 'EleanorTerrett'],
  ['CoinDesk', 'TheBlock__', 'WuBlockchain', 'WatcherGuru'],
  ['RektCapital', 'WClementeIII', 'Pentosh1'],
  ['CryptoHayes', 'RaoulGMI', 'CryptoCred'],
];

const MARKET_IMPACT_MEDIA_COHORTS = [
  ['lookonchain', 'glassnode', 'cryptoquant_com'],
  ['RektCapital', 'WClementeIII', 'glassnode', 'lookonchain'],
  ['CoinDesk', 'TheBlock__', 'WuBlockchain', 'WatcherGuru'],
  ['EricBalchunas', 'JSeyff', 'NateGeraci', 'EleanorTerrett'],
];

const GENERIC_LOW_QUALITY_QUERY_EXCLUSIONS = [
  '-giveaway',
  '-contest',
  '-competition',
  '-voucher',
  '-vouchers',
  '-rewards',
  '-campaign',
  '-referral',
  '-"claim your share"',
  '-"watch the full interview"',
  '-"full interview"',
  '-"get access"',
  '-"now live"',
  '-"limited time"',
  '-"retail access"',
  '-"private assets"',
  '-"trade now"',
];

function withGenericLowQualityExclusions(parts: string[]): string[] {
  return [...parts, ...GENERIC_LOW_QUALITY_QUERY_EXCLUSIONS];
}

export const cryptoSourceStrategy: CategorySourceStrategy = {
  id: 'crypto',
  canHandleSource: (source) => isCryptoRotationSource(source),
  buildRotationPlan: (source, bucket) => buildCryptoRotationPlan(source, bucket),
  buildRotationAttempts: (plan) => buildCryptoRotationAttempts(plan),
};

export function isCryptoRotationSource(source: ApifyRotationSourceRow): boolean {
  return String(source.category_id ?? '').trim().toLowerCase() === 'crypto'
    && source.platform === 'x'
    && CRYPTO_ROTATION_SOURCE_IDS.has(source.id);
}

export function buildCryptoRotationPlan(source: ApifyRotationSourceRow, bucket: number): ApifyRotationPlan | null {
  const id = source.id;

  // PATCH: topic gates removed from primary cohort plans.
  // Trusted crypto accounts (CoinDesk, TheBlock__, lookonchain etc) post crypto
  // content by definition — adding a 200-character keyword gate on top of a
  // short time window meant Twitter found 0 matching tweets and the actor
  // returned mock data. Primary now uses clean profile queries.
  if (id === 'src_crypto_x_news_media') {
    return buildCohortPlan(source, NEWS_COHORTS, bucket + 3, 'core_news', 'media', 18);
  }

  if (id === 'src_crypto_x_news_text') {
    return buildCohortPlan(source, NEWS_COHORTS, bucket, 'core_news', 'text', 18);
  }

  if (id === 'src_crypto_x_voices_media') {
    return buildCohortPlan(source, VOICES_COHORTS, bucket + 4, 'expert_signals', 'media', 8);
  }

  if (id === 'src_crypto_x_voices_text') {
    return buildCohortPlan(source, VOICES_COHORTS, bucket, 'expert_signals', 'text', 16);
  }

  if (id === 'src_market_trending_x_media') {
    return buildMarketImpactPlan(source, bucket + 5, 'media', 10);
  }

  if (id === 'src_market_trending_x_text') {
    return buildMarketImpactPlan(source, bucket + 6, 'text', 10);
  }

  // IMPROVEMENT #2: discovery lanes — top/trending across the whole timeline.
  if (id === 'src_crypto_x_discovery_latest') {
    return buildDiscoveryPlan(source, bucket, 'Latest', 4, 20);
  }
  if (id === 'src_crypto_x_discovery_top') {
    return buildDiscoveryPlan(source, bucket, 'Top', 8, 20);
  }

  return null;
}

// ── IMPROVEMENT #2: Discovery lane (v4) ─────────────────────────────────────
// Reads high-signal crypto posts from the ENTIRE timeline (no from:), unlike the
// profile cohorts. Rotates topic queries by bucket. Safety properties:
//   - NO fallback attempt (see buildCryptoRotationAttempts: empty accounts → no fallback).
//   - small maxItems (20) to cap per-slot cost.
//   - TOPIC-SPECIFIC exclusions: v4 fixes the v3 self-sabotage where a query said
//     "find phishing" while the global exclusion said "-phishing". Each topic now
//     carries only exclusions that don't contradict its own positive terms.
//   - min_faves/min_retweets engagement floor — NOTE: the kaito actor may ignore
//     these; verify against the live actor schema before relying on them.
//
// Each entry pairs a positive topic with exclusions that never negate its terms.
interface DiscoveryTopic { topic: string; exclude: string }

// Common junk exclusions safe for EVERY topic (none of these are positive terms).
const DISCOVERY_COMMON_EXCLUDES = '-giveaway -presale -"claim now" -referral -"mint now" -lottery -casino -100x -filter:replies';

const DISCOVERY_TOPICS: DiscoveryTopic[] = [
  {
    topic: 'bitcoin OR ethereum OR "spot ETF" OR stablecoin OR USDT OR SEC OR CFTC',
    exclude: `${DISCOVERY_COMMON_EXCLUDES} -scam -fake`,
  },
  {
    // security lane: do NOT exclude -phishing here (it IS a positive term).
    topic: 'crypto hack OR exploit OR drained OR "stolen funds" OR phishing OR "private key"',
    exclude: DISCOVERY_COMMON_EXCLUDES,
  },
  {
    // memecoin lane: do NOT exclude -airdrop here (airdrop is a positive term);
    // keep -scam/-fake since those never overlap the positives.
    topic: 'XRP OR TON OR DOGE OR SHIB OR memecoin OR "exchange listing" OR airdrop',
    exclude: `${DISCOVERY_COMMON_EXCLUDES} -scam -fake`,
  },
  {
    topic: 'onchain OR "exchange outflow" OR "exchange inflow" OR liquidation OR "open interest"',
    exclude: `${DISCOVERY_COMMON_EXCLUDES} -scam -fake`,
  },
  {
    // PRICE-ACTION lane: قیمت و نوسان ارزهای محبوب (محتوای مورد علاقه مخاطب فارسی).
    // تمرکز روی حرکت قیمت واقعی، نه وعده‌ی صعود. -shill/-"buy now" جلوی pump را می‌گیرد.
    topic: '("bitcoin price" OR "btc price" OR "ethereum price" OR "eth price" OR "solana price" OR "sol price" OR "xrp price" OR "price analysis" OR "all-time high" OR "ATH" OR rally OR "sell-off" OR correction OR breakout)',
    exclude: `${DISCOVERY_COMMON_EXCLUDES} -scam -fake -shill -"buy now" -"sell now" -pump`,
  },
  {
    // TECHNICAL-ANALYSIS lane: تحلیل فنی و سطوح، نه سیگنال خرید.
    // "support"/"resistance"/"chart" محتوای تحلیلی است؛ -"signal group" -"100x" pump را رد می‌کند.
    topic: '("technical analysis" OR "support level" OR "resistance level" OR "key support" OR "key resistance" OR "moving average" OR RSI OR "chart pattern" OR "trading range" OR consolidation)',
    exclude: `${DISCOVERY_COMMON_EXCLUDES} -scam -fake -shill -"signal group" -"join my" -"vip signals"`,
  },
];

function buildDiscoveryPlan(
  source: ApifyRotationSourceRow,
  bucket: number,
  queryType: 'Latest' | 'Top',
  hoursBack: number,
  maxItems: number,
): ApifyRotationPlan {
  const idx = positiveModulo(bucket, DISCOVERY_TOPICS.length);
  const { topic, exclude } = DISCOVERY_TOPICS[idx]!;
  const query = `(${topic}) lang:en ${exclude}`.trim();
  return {
    source,
    cohortName: `discovery_${queryType.toLowerCase()}_${idx}`,
    cohortIndex: idx,
    accounts: [],
    inputOverride: buildTopicSearchInputOverride(
      query,
      maxItems,
      hoursBack,
      queryType,
      { minFaves: 50, minRetweets: 5 },
    ),
  };
}

// PATCH summary for buildCryptoRotationAttempts:
// 1. Fallback renamed same_accounts_profile_24h (was 7d) — window cut from 168h to 24h.
// 2. Rescue fallback also cut to 24h.
// These two changes alone should stop the duplicate storm: a 7-day profile dump
// against accounts that post 5-20 times/day was guaranteeing 100-200 known
// tweets per slot, all already in the dedupe table.
export function buildCryptoRotationAttempts(plan: ApifyRotationPlan): ApifyRotationAttemptPlan[] {
  const baseMaxItems = positiveNumber(plan.inputOverride.maxItems, 18);
  const attempts: ApifyRotationAttemptPlan[] = [
    {
      attempt: 'primary',
      inputOverride: plan.inputOverride,
    },
  ];

  // IMPROVEMENT #2: discovery lanes have NO accounts → NO fallback. A dry
  // discovery slot just yields 0; we never escalate to an account-profile
  // fallback (there are none) and never burn extra paid actor events.
  if (!plan.accounts || plan.accounts.length === 0) {
    return attempts;
  }

  const sameAccountsTerms = buildProfileSearchTerms(plan.accounts, 'default');
  attempts.push({
    attempt: 'same_accounts_profile_24h',
    reason: 'Primary query returned no real tweet rows; retry same accounts for last 24h without topic/media gates.',
    inputOverride: buildSearchInputOverride(
      sameAccountsTerms,
      Math.max(baseMaxItems, 30),
      24, // was 168
    ),
  });

  const rescueAccounts = rescueAccountsForSource(plan.source.id, plan.accounts);
  if (rescueAccounts.join('|').toLowerCase() !== plan.accounts.join('|').toLowerCase()) {
    const rescueTerms = buildProfileSearchTerms(rescueAccounts, 'default', buildRescueTopicGate());
    attempts.push({
      attempt: 'source_rescue_pool_24h',
      reason: 'Same-account fallback returned no real tweet rows; retry trusted high-yield source pool.',
      inputOverride: buildSearchInputOverride(
        rescueTerms,
        Math.max(baseMaxItems, 40),
        24, // was 168
      ),
    });
  }

  return attempts;
}

function buildCohortPlan(
  source: ApifyRotationSourceRow,
  cohorts: string[][],
  bucket: number,
  family: string,
  mode: ApifyRotationMode,
  maxItems: number,
  topicGate?: string,
  minFaves?: number,
): ApifyRotationPlan {
  const index = positiveModulo(bucket, cohorts.length);
  const accounts = cohorts[index] ?? cohorts[0]!;

  // Use Kaito searchTerms: one independent X query per account.
  // This avoids one large `(from:a OR from:b)` twitterContent string, which
  // produced Kaito id=-1/no-result rows for low-volume news accounts.
  const searchTerms = topicGate
    ? buildProfileSearchTerms(accounts, mode, topicGate)
    : buildCleanProfileSearchTerms(accounts, mode);

  return {
    source,
    cohortName: `${family}_${mode}_${index}`,
    cohortIndex: index,
    accounts,
    inputOverride: buildSearchInputOverride(searchTerms, maxItems, 12, { minFaves }),
  };
}

function buildCleanProfileSearchTerms(
  accounts: string[],
  mode: ApifyRotationMode,
): string[] {
  return accounts.map(account => {
    const parts = [`from:${account}`];
    if (mode === 'media') parts.push('filter:media');
    if (mode === 'text') parts.push('-filter:media');
    return withGenericLowQualityExclusions([
      ...parts,
      '-filter:replies',
      'lang:en',
      '-presale',
      '-airdrop',
    ]).join(' ');
  });
}

function buildProfileSearchTerms(
  accounts: string[],
  mode: ApifyRotationMode,
  topicGate?: string,
): string[] {
  return accounts.map(account => {
    const parts = [`from:${account}`];
    if (topicGate) parts.push(topicGate);
    if (mode === 'media') parts.push('filter:media');
    if (mode === 'text') parts.push('-filter:media');
    parts.push('-filter:replies', 'lang:en');
    return parts.join(' ');
  });
}

function buildCoreNewsTopicGate(): string {
  return withGenericLowQualityExclusions([
    '(',
    'crypto OR bitcoin OR ethereum OR XRP OR ripple OR dogecoin OR DOGE OR SHIB OR TON OR',
    'stablecoin OR USDT OR Tether OR USDC OR "spot ETF" OR "Bitcoin ETF" OR "Ethereum ETF" OR',
    'DeFi OR RWA OR tokenization OR exchange OR treasury OR Coinbase OR Binance OR wallet OR',
    '"digital asset" OR SEC OR CFTC OR regulation OR lawsuit OR approval OR filing OR',
    'launch OR partnership OR acquisition OR funding OR hack OR exploit OR upgrade OR mainnet OR listing',
    ')',
  ]).join(' ');
}

function buildExpertSignalsTopicGate(): string {
  return withGenericLowQualityExclusions([
    '(',
    'BTC OR bitcoin OR ETH OR ethereum OR XRP OR DOGE OR SHIB OR TON OR',
    'ETF OR SEC OR CFTC OR liquidity OR liquidation OR liquidations OR',
    '"funding rate" OR "open interest" OR onchain OR whale OR USDT OR Tether OR',
    'DeFi OR RWA OR listing OR "crypto hack" OR "DeFi hack" OR "smart contract exploit" OR "protocol exploit" OR governance OR upgrade OR mainnet',
    ')',
  ]).join(' ');
}

function buildMarketImpactPlan(source: ApifyRotationSourceRow, bucket: number, mode: ApifyRotationMode, maxItems: number): ApifyRotationPlan {
  const cohorts = mode === 'media' ? MARKET_IMPACT_MEDIA_COHORTS : MARKET_IMPACT_TEXT_COHORTS;
  const index = positiveModulo(bucket, cohorts.length);
  const accounts = cohorts[index] ?? cohorts[0]!;

  const searchTerms = buildCleanProfileSearchTerms(accounts, mode);

  return {
    source,
    cohortName: `market_impact_${mode}_${index}`,
    cohortIndex: index,
    accounts,
    inputOverride: buildSearchInputOverride(searchTerms, maxItems),
  };
}

function buildMarketImpactTopicGate(): string {
  return withGenericLowQualityExclusions([
    '(',
    'BTC OR bitcoin OR ETH OR ethereum OR XRP OR DOGE OR SHIB OR TON OR',
    'ETF OR "spot ETF" OR "ETF flows" OR USDT OR Tether OR stablecoin OR',
    '"stablecoin supply" OR onchain OR whale OR liquidation OR liquidations OR',
    '"open interest" OR "funding rate" OR "exchange reserves" OR',
    '"exchange inflow" OR "exchange outflow" OR CPI OR Fed OR treasury',
    ')',
    '-giveaway',
    '-presale',
    '-airdrop',
    '-memecoin',
    '-meme',
    '-parabolic',
    '-moon',
    '-100x',
    '-lottery',
    '-casino',
    '-prediction',
    '-astrology',
  ]).join(' ');
}

function buildTokenProjectWatchPlan(source: ApifyRotationSourceRow, bucket: number, maxItems: number): ApifyRotationPlan {
  const index = positiveModulo(bucket, TOKEN_PROJECT_COHORTS.length);
  const accounts = TOKEN_PROJECT_COHORTS[index] ?? TOKEN_PROJECT_COHORTS[0]!;

  // PATCH: Clean profile query for primary — topic gate removed.
  const searchTerms = buildCleanProfileSearchTerms(accounts, 'text');

  return {
    source,
    cohortName: `token_project_watch_text_${index}`,
    cohortIndex: index,
    accounts,
    inputOverride: buildSearchInputOverride(searchTerms, maxItems),
  };
}

function buildTokenProjectWatchTopicGate(): string {
  return withGenericLowQualityExclusions([
    '(',
    '"mainnet" OR "testnet" OR "token launch" OR TGE OR',
    'listing OR "Binance listing" OR "Coinbase listing" OR "Bybit listing" OR "MEXC listing" OR',
    '"protocol upgrade" OR governance OR "smart contract exploit" OR "protocol exploit" OR "bridge exploit" OR "DeFi hack" OR "crypto security incident" OR',
    '"funding round" OR "Series A" OR "Series B" OR "Series C" OR RWA OR "stablecoin launch" OR',
    'airdrop OR "token generation" OR "tap to earn" OR TON OR Notcoin OR DOGS OR "Hamster Kombat"',
    ')',
    '(',
    'crypto OR blockchain OR DeFi OR Ethereum OR Solana OR Base OR',
    'Bitcoin OR token OR protocol OR Telegram',
    ')',
    '-giveaway',
    '-presale',
    '-"airdrop claim"',
    '-referral',
    '-"mint now"',
    '-whitelist',
    '-scam',
    '-fake',
    '-phishing',
  ]).join(' ');
}

function buildSecurityAlertPlan(source: ApifyRotationSourceRow, bucket: number, maxItems: number): ApifyRotationPlan {
  const index = positiveModulo(bucket, SECURITY_ALERT_COHORTS.length);
  const accounts = SECURITY_ALERT_COHORTS[index] ?? SECURITY_ALERT_COHORTS[0]!;

  // Security alert accounts post non-crypto security too — keep the topic gate.
  const searchTerms = buildProfileSearchTerms(accounts, 'text', buildSecurityAlertTopicGate());

  return {
    source,
    cohortName: `security_alert_text_${index}`,
    cohortIndex: index,
    accounts,
    inputOverride: buildSearchInputOverride(searchTerms, maxItems),
  };
}

function buildSecurityAlertTopicGate(): string {
  return withGenericLowQualityExclusions([
    '(',
    '"crypto hack" OR "DeFi hack" OR "protocol exploit" OR "smart contract exploit" OR',
    '"crypto security incident" OR "rug pull" OR "wallet phishing" OR "private key" OR "seed phrase" OR',
    '"smart contract vulnerability" OR "bridge attack" OR "wallet drained" OR "funds drained"',
    ')',
    '(',
    'crypto OR DeFi OR protocol OR wallet OR exchange OR blockchain OR web3',
    ')',
    '-airdrop',
    '-giveaway',
    '-presale',
    '-referral',
    '-"drain your wallet"',
    '-"saved me"',
    '-potato',
    '-fridge',
    '-recipe',
    '-NSFW',
    '-adult',
    '-pypi',
    '-npm',
    '-python',
    '-bun',
    '-package',
    '-packages',
    '-dependency',
    '-dependencies',
    '-ransomware',
    '-breach',
    '-"data breach"',
    '-"supply chain"',
    '-"supply-chain"',
  ]).join(' ');
}

function buildTopicSearchInputOverride(
  query: string,
  maxItems: number,
  hoursBack = 12,
  queryType: 'Latest' | 'Top' = 'Latest',
  engagement?: { minFaves?: number; minRetweets?: number },
): Record<string, unknown> {
  return buildSearchInputOverride([query], maxItems, hoursBack, engagement, queryType);
}

// Build input matching the KaitoEasyAPI actor schema.
// Scrape freshness uses a rolling UTC search window. Publishing remains governed
// elsewhere by the channel timezone, e.g. Asia/Tehran.
function buildSearchInputOverride(
  searchTerms: string[],
  maxItems: number,
  hoursBack = 12,
  engagement?: { minFaves?: number; minRetweets?: number },
  queryType: 'Latest' | 'Top' = 'Latest',
): Record<string, unknown> {
  const windowedSearchTerms = appendUtcSearchWindow(searchTerms, hoursBack);
  const minFaves = Math.max(0, Math.floor(Number(engagement?.minFaves ?? 0)));
  const minRetweets = Math.max(0, Math.floor(Number(engagement?.minRetweets ?? 0)));

  return {
    tweetIDs: [],
    twitterContent: '',
    searchTerms: windowedSearchTerms,
    maxItems,
    queryType,
    lang: 'en',
    since_time: currentSinceTimeSeconds(hoursBack),
    until_time: '',
    from: '',
    to: '',
    '@': '',
    list: '',
    near: '',
    within: '',
    geocode: '',
    since_id: '',
    max_id: '',
    conversation_id: '',
    quoted_tweet_id: '',
    quoted_user_id: '',
    url: '',
    'filter:blue_verified': false,
    'filter:consumer_video': false,
    'filter:has_engagement': false,
    'filter:hashtags': false,
    'filter:images': false,
    'filter:links': false,
    'filter:media': false,
    'filter:mentions': false,
    'filter:native_video': false,
    'filter:nativeretweets': false,
    'filter:news': false,
    'filter:pro_video': false,
    'filter:quote': false,
    'filter:replies': false,
    'filter:safe': false,
    'filter:spaces': false,
    'filter:twimg': false,
    'filter:videos': false,
    'filter:vine': false,
    'include:nativeretweets': false,
    min_retweets: minRetweets,
    min_faves: minFaves,
    min_replies: 0,
    '-min_retweets': 0,
    '-min_faves': 0,
    '-min_replies': 0,
  };
}

function currentSinceTimeSeconds(hoursBack = 24): string {
  return String(Math.floor(Date.now() / 1000) - hoursBack * 60 * 60);
}

function appendUtcSearchWindow(searchTerms: string[], hoursBack: number): string[] {
  const until = new Date();
  const since = new Date(until.getTime() - hoursBack * 60 * 60 * 1000);
  const sinceTerm = `since:${formatXSearchUtc(since)}`;
  const untilTerm = `until:${formatXSearchUtc(until)}`;

  return searchTerms.map(term => {
    const cleaned = String(term ?? '').trim();
    if (!cleaned) return `${sinceTerm} ${untilTerm}`;
    return `${cleaned} ${sinceTerm} ${untilTerm}`;
  });
}

function formatXSearchUtc(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, '_UTC').replace('T', '_');
}

function rescueAccountsForSource(sourceId: string, currentAccounts: string[]): string[] {
  switch (sourceId) {
    case 'src_crypto_x_news_media':
    case 'src_crypto_x_news_text':
      return [
        'WatcherGuru',
        'WuBlockchain',
        'CoinDesk',
        'Cointelegraph',
        'TheBlock__',
        'decryptmedia',
        'BitcoinMagazine',
        'News_Of_Alpha',
      ];

    case 'src_crypto_x_voices_media':
    case 'src_crypto_x_voices_text':
      return [
        'EricBalchunas',
        'JSeyff',
        'NateGeraci',
        'EleanorTerrett',
        'zachxbt',
        'PeckShieldAlert',
        'SlowMist_Team',
        'CoinbaseAssets',
        'binance',
      ];

    case 'src_market_trending_x_media':
    case 'src_market_trending_x_text':
      return [
        'DefiLlama',
        'BanklessHQ',
        'TheDefiantNews',
        'Tree_of_Alpha',
        'lookonchain',
        'glassnode',
        'cryptoquant_com',
        'solana',
        'base',
        'chainlink',
      ];

    default:
      return currentAccounts;
  }
}

function buildRescueTopicGate(): string {
  return withGenericLowQualityExclusions([
    '(',
    'crypto OR bitcoin OR BTC OR ethereum OR ETH OR Solana OR stablecoin OR USDT OR USDC OR',
    'ETF OR "spot ETF" OR SEC OR CFTC OR regulation OR lawsuit OR filing OR approval OR',
    'hack OR exploit OR mainnet OR upgrade OR listing OR "token launch" OR DeFi OR RWA OR',
    'onchain OR whale OR liquidation OR liquidations OR "open interest" OR "funding rate"',
    ')',
    '-giveaway',
    '-presale',
    '-"airdrop claim"',
    '-referral',
    '-"mint now"',
    '-whitelist',
    '-scam',
    '-fake',
    '-phishing',
    '-lottery',
    '-casino',
    '-100x',
  ]).join(' ');
}

function positiveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function positiveModulo(value: number, size: number): number {
  return ((value % size) + size) % size;
}
