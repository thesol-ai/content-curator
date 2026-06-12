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

const MARKET_IMPACT_COHORTS = [
  ['lookonchain', 'glassnode', 'cryptoquant_com'],
  ['EricBalchunas', 'JSeyff', 'NateGeraci', 'EleanorTerrett'],
  ['CoinDesk', 'TheBlock__', 'WuBlockchain', 'WatcherGuru'],
  ['VitalikButerin', 'ethereum', 'solana', 'base', 'chainlink'],
];

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

  if (id === 'src_crypto_x_news_media') {
    return buildCohortPlan(source, NEWS_COHORTS, bucket + 3, 'core_news', 'media', 18, buildCoreNewsTopicGate());
  }

  if (id === 'src_crypto_x_news_text') {
    return buildCohortPlan(source, NEWS_COHORTS, bucket, 'core_news', 'text', 18, buildCoreNewsTopicGate());
  }

  if (id === 'src_crypto_x_voices_media') {
    return buildSecurityAlertPlan(source, bucket + 4, 8);
  }

  if (id === 'src_crypto_x_voices_text') {
    return buildCohortPlan(source, VOICES_COHORTS, bucket, 'expert_signals', 'text', 16, buildExpertSignalsTopicGate());
  }

  if (id === 'src_market_trending_x_media') {
    return buildTokenProjectWatchPlan(source, bucket + 5, 10);
  }

  if (id === 'src_market_trending_x_text') {
    return buildMarketImpactPlan(source, bucket + 6, 'text', 10);
  }

  return null;
}

export function buildCryptoRotationAttempts(plan: ApifyRotationPlan): ApifyRotationAttemptPlan[] {
  const baseMaxItems = positiveNumber(plan.inputOverride.maxItems, 18);
  const attempts: ApifyRotationAttemptPlan[] = [
    {
      attempt: 'primary',
      inputOverride: plan.inputOverride,
    },
  ];

  const sameAccountsQuery = buildProfileTopicContent(plan.accounts, 'default');
  attempts.push({
    attempt: 'same_accounts_profile_7d',
    reason: 'Primary query returned no real tweet rows; retry same accounts without strict topic/media gates.',
    inputOverride: buildSearchInputOverride(
      sameAccountsQuery,
      Math.max(baseMaxItems, 30),
      168,
    ),
  });

  const rescueAccounts = rescueAccountsForSource(plan.source.id, plan.accounts);
  if (rescueAccounts.join('|').toLowerCase() !== plan.accounts.join('|').toLowerCase()) {
    const rescueQuery = buildProfileTopicContent(rescueAccounts, 'default', buildRescueTopicGate());
    attempts.push({
      attempt: 'source_rescue_pool_7d',
      reason: 'Same-account fallback returned no real tweet rows; retry trusted high-yield source pool.',
      inputOverride: buildSearchInputOverride(
        rescueQuery,
        Math.max(baseMaxItems, 40),
        168,
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
  const query = topicGate
    ? buildProfileTopicContent(accounts, mode, topicGate, minFaves)
    : buildTwitterContent(accounts, mode);

  return {
    source,
    cohortName: `${family}_${mode}_${index}`,
    cohortIndex: index,
    accounts,
    inputOverride: buildSearchInputOverride(query, maxItems),
  };
}

function buildTwitterContent(accounts: string[], mode: ApifyRotationMode): string {
  return buildProfileTopicContent(accounts, mode);
}

function buildProfileTopicContent(
  accounts: string[],
  mode: ApifyRotationMode,
  topicGate?: string,
  minFaves = 0,
): string {
  const accountQuery = accounts.map(account => `from:${account}`).join(' OR ');
  const parts = [`(${accountQuery})`];

  if (topicGate) parts.push(topicGate);
  if (mode === 'media') parts.push('filter:media');
  if (mode === 'text') parts.push('-filter:media');

  parts.push('-filter:replies', 'lang:en');
  if (minFaves > 0) parts.push(`min_faves:${minFaves}`);

  return parts.join(' ');
}

function buildCoreNewsTopicGate(): string {
  return [
    '(',
    'crypto OR bitcoin OR ethereum OR XRP OR ripple OR dogecoin OR DOGE OR SHIB OR TON OR',
    'stablecoin OR USDT OR Tether OR USDC OR "spot ETF" OR "Bitcoin ETF" OR "Ethereum ETF" OR',
    'DeFi OR RWA OR tokenization OR exchange OR treasury OR Coinbase OR Binance OR wallet OR',
    '"digital asset" OR SEC OR CFTC OR regulation OR lawsuit OR approval OR filing OR',
    'launch OR partnership OR acquisition OR funding OR hack OR exploit OR upgrade OR mainnet OR listing',
    ')',
  ].join(' ');
}

function buildExpertSignalsTopicGate(): string {
  return [
    '(',
    'BTC OR bitcoin OR ETH OR ethereum OR XRP OR DOGE OR SHIB OR TON OR',
    'ETF OR SEC OR CFTC OR liquidity OR liquidation OR liquidations OR',
    '"funding rate" OR "open interest" OR onchain OR whale OR USDT OR Tether OR',
    'DeFi OR RWA OR listing OR "crypto hack" OR "DeFi hack" OR "smart contract exploit" OR "protocol exploit" OR governance OR upgrade OR mainnet',
    ')',
  ].join(' ');
}

function buildMarketImpactPlan(source: ApifyRotationSourceRow, bucket: number, mode: ApifyRotationMode, maxItems: number): ApifyRotationPlan {
  const index = positiveModulo(bucket, MARKET_IMPACT_COHORTS.length);
  const accounts = MARKET_IMPACT_COHORTS[index] ?? MARKET_IMPACT_COHORTS[0]!;
  const query = buildProfileTopicContent(accounts, mode, buildMarketImpactTopicGate());

  return {
    source,
    cohortName: `market_impact_${mode}_${index}`,
    cohortIndex: index,
    accounts,
    inputOverride: buildSearchInputOverride(query, maxItems),
  };
}

function buildMarketImpactTopicGate(): string {
  return [
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
  ].join(' ');
}

function buildTokenProjectWatchPlan(source: ApifyRotationSourceRow, bucket: number, maxItems: number): ApifyRotationPlan {
  const index = positiveModulo(bucket, TOKEN_PROJECT_COHORTS.length);
  const accounts = TOKEN_PROJECT_COHORTS[index] ?? TOKEN_PROJECT_COHORTS[0]!;
  const query = buildProfileTopicContent(accounts, 'text', buildTokenProjectWatchTopicGate());

  return {
    source,
    cohortName: `token_project_watch_text_${index}`,
    cohortIndex: index,
    accounts,
    inputOverride: buildSearchInputOverride(query, maxItems),
  };
}

function buildTokenProjectWatchTopicGate(): string {
  return [
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
  ].join(' ');
}

function buildSecurityAlertPlan(source: ApifyRotationSourceRow, bucket: number, maxItems: number): ApifyRotationPlan {
  const index = positiveModulo(bucket, SECURITY_ALERT_COHORTS.length);
  const accounts = SECURITY_ALERT_COHORTS[index] ?? SECURITY_ALERT_COHORTS[0]!;
  const query = buildProfileTopicContent(accounts, 'text', buildSecurityAlertTopicGate());

  return {
    source,
    cohortName: `security_alert_text_${index}`,
    cohortIndex: index,
    accounts,
    inputOverride: buildSearchInputOverride(query, maxItems),
  };
}

function buildSecurityAlertTopicGate(): string {
  return [
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
  ].join(' ');
}

function buildSearchInputOverride(query: string, maxItems: number, hoursBack = 72): Record<string, unknown> {
  return {
    query,
    twitterContent: query,
    maxItems,
    queryType: 'Latest',
    lang: 'en',
    since_time: currentSinceTimeSeconds(hoursBack),
  };
}

function currentSinceTimeSeconds(hoursBack = 24): string {
  return String(Math.floor(Date.now() / 1000) - hoursBack * 60 * 60);
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
  return [
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
  ].join(' ');
}

function positiveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function positiveModulo(value: number, size: number): number {
  return ((value % size) + size) % size;
}
