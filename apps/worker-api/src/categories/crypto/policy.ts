import type { NormalizedItem } from '../../types';
import type { CategoryPolicy } from '../types';
import { buildCryptoScoringPolicy } from './prompts';

export const cryptoPolicy: CategoryPolicy = {
  id: 'crypto',
  getPreAiRejectReason: (item) => getCryptoPreAiRejectReason(item),
  buildScoringPolicy: () => buildCryptoScoringPolicy(),
};

function getCryptoPreAiRejectReason(item: NormalizedItem): string | null {
  const body = normalizeText(item.text);
  const account = normalizeAccount(item.sourceAccount);

  if (!body) return 'pre_ai_empty_text';
  if (isEngagementBait(body)) return 'pre_ai_engagement_bait';
  if (isWeakCryptoAdjacentPrivateAssetStory(body)) return 'pre_ai_weak_crypto_adjacent_private_asset';

  if (account === 'whale_alert') {
    return getWhaleAlertRejectReason(body);
  }

  if (mentionsGenericSoftwareSecurity(body) && !hasExplicitCryptoSecurityRelevance(body)) {
    return 'pre_ai_generic_software_security';
  }

  if (mentionsGenericAi(body) && !hasCryptoRelevance(body, account)) {
    return 'pre_ai_generic_ai_news';
  }

  if (mentionsGenericEquityOrSpaceX(body) && !hasCryptoRelevance(body, account)) {
    return 'pre_ai_generic_equity_or_spacex';
  }

  if (mentionsGenericGeopolitics(body) && !hasCryptoRelevance(body, account)) {
    return 'pre_ai_generic_geopolitics';
  }

  if (!hasCryptoRelevance(body, account)) return 'pre_ai_non_crypto';

  const editorialSubstanceRejectReason = getCryptoEditorialSubstanceRejectReason(body);
  if (editorialSubstanceRejectReason) return editorialSubstanceRejectReason;

  return null;
}

function hasCryptoRelevance(body: string, account: string): boolean {
  // Strict channel rule:
  // Source account reputation alone is NOT enough. But crypto-native sources plus
  // concrete crypto/security/protocol context should not be falsely dropped as non-crypto.
  if (hasAny(body, DIRECT_CRYPTO_ANCHORS)) return true;
  if (isTrustedCryptoNativeSource(account) && hasAny(body, CRYPTO_NATIVE_CONTEXT_TERMS)) return true;
  return false;
}

function isTrustedCryptoNativeSource(account: string): boolean {
  return hasAny(account, [
    'defiantnews',
    'thedefiantnews',
    'defillama',
    'peckshieldalert',
    'slowmist_team',
    'cyversalerts',
    'wublockchain',
    'zachxbt',
    'theblock__',
    'dlnewsinfo',
  ]);
}


const DIRECT_CRYPTO_ANCHORS = [
  // Core assets / tickers
  'bitcoin',
  ' btc',
  '$btc',
  'ethereum',
  ' eth',
  '$eth',
  'solana',
  ' xrp',
  '$xrp',
  'dogecoin',
  ' doge',
  '$doge',
  'shib',
  '$shib',

  // Crypto category terms
  'crypto',
  'cryptocurrency',
  'blockchain',
  'digital asset',
  'digital-asset',
  'virtual digital asset',
  'virtual digital assets',
  'vda',
  'schedule vda',
  'crypto tax',
  'digital asset tax',
  'tax deducted at source',
  'tds',
  'stablecoin',
  'usdt',
  'tether',
  'usdc',
  'defi',
  'onchain',
  'on-chain',
  'web3',
  'smart contract',
  'raydium',
  'starknet',
  'erc-20',
  'erc20',
  'bnbchain',
  'bnb chain',
  'kucoin',
  'tornado cash',
  'cross-chain bridge',
  'cross chain bridge',
  'shielded erc-20',

  // Safer wallet/security terms. Generic "wallet", "hack", "exploit" are intentionally NOT enough.
  'crypto wallet',
  'web3 wallet',
  'wallet drain',
  'wallet drainer',
  'seed phrase',
  'private key',
  'smart contract exploit',
  'defi exploit',
  'bridge exploit',
  'crypto hack',
  'defi hack',
  'protocol exploit',
  'stolen funds',
  'funds stolen',
  'drained funds',

  // DeFi / protocol / chain terms
  'mainnet',
  'testnet',
  'validator',
  'staking',
  'governance token',
  'liquidity pool',
  'lending protocol',
  'dex',
  'dao',
  'dapp',
  'airdrop',
  'tge',

  // Tokenization / RWA, still crypto-adjacent enough
  'tokenized',
  'tokenization',
  'rwa',
  'real-world asset',
  'real world asset',

  // Known crypto venues / infra
  'coinbase',
  'binance',
  'kraken',
  'bybit',
  'bitget',
  'okx',
  'mexc',
  'bitfinex',
  'uniswap',
  'aave',
  'curve',
  'metamask',
  'phantom',
  'ledger',

  // Chains / ecosystems
  'chainlink',
  'base chain',
  'bnb chain',
  'arbitrum',
  'optimism',
  'polygon',
  'avalanche',
  'ton blockchain',
  'ton ecosystem',

  // Crypto ETF / regulation
  'spot bitcoin etf',
  'bitcoin etf',
  'ethereum etf',
  'crypto etf',
  'sec crypto',
  'cftc crypto',
  'digital asset regulation',
  'clarity act',
  'stablecoin bill',

  // Telegram crypto games / mini app ecosystem
  'telegram mini app',
  'telegram mini',
  'notcoin',
  'hamster kombat',
];


const CRYPTO_NATIVE_CONTEXT_TERMS = [
  'etf',
  'sec',
  'cftc',
  'filing',
  'approval',
  'lawsuit',
  'regulation',
  'treasury',
  'liquidity',
  'liquidation',
  'liquidations',
  'open interest',
  'funding rate',
  'mint',
  'minted',
  'token mint',
  'lp mint',
  'burned',
  'drained',
  'exploit',
  'exploited',
  'protocol exploit',
  'compromised private key',
  'admin privileges',
  'tornado cash',
  'kucoin',
  'cross-chain',
  'cross chain',
  'erc-20',
  'erc20',
  'raydium',
  'starknet',
  'bnbchain',
  'burn',
  'reserve',
  'reserves',
  'inflow',
  'outflow',
  'upgrade',
  'governance',
  'validator',
  'staking',
];

const ETF_REGULATORY_TERMS = [
  'etf',
  'spot',
  'sec',
  'cftc',
  'filing',
  'approval',
  '19b-4',
  's-1',
  'issuer',
];

function isWeakCryptoAdjacentPrivateAssetStory(body: string): boolean {
  const hasPrivateAssetAngle =
    hasAny(body, ['spcx', 'spacex', 'private asset', 'private assets', 'pre ipo', 'pre-ipo'])
    && hasAny(body, ['stock', 'stocks', 'shares', 'equity', 'ipo', 'private market', 'blackrock', 'fund', 'funds', 'etf']);

  if (!hasPrivateAssetAngle) return false;

  // Explicit crypto rails make this a real crypto/RWA story. It can still be
  // rejected later for marketing/low utility, but not as generic private equity.
  if (hasAny(body, [
    'crypto platforms',
    'tokenized equity',
    'tokenized shares',
    'tokenized stock',
    'rwa rails',
    'rwa markets',
    'rwa',
    'tokenized',
    'tokenization',
    'onchain',
    'on-chain',
    'solana',
    'ethereum',
    'base',
    'blockchain',
  ])) {
    return false;
  }

  return !hasAny(body, ['bitcoin etf', 'ethereum etf', 'spot bitcoin etf', 'spot ethereum etf', 'crypto etf']);
}

function hasCryptoTaxOrVdaSignal(body: string): boolean {
  return hasAny(body, [
    'virtual digital asset',
    'virtual digital assets',
    'schedule vda',
    ' vda ',
    'crypto tax',
    'digital asset tax',
    'tax deducted at source',
    'tds',
    'undisclosed vda income',
    'vda-related notices',
    'wallet providers',
    'custodians',
  ]);
}

function mentionsGenericSoftwareSecurity(body: string): boolean {
  if (hasCryptoTaxOrVdaSignal(body)) return false;
  return hasAny(body, [
    'pypi',
    'npm',
    'package',
    'packages',
    'supply chain',
    'supply-chain',
    'malware',
    'backdoor',
    'trojan',
    'rce',
    'remote code execution',
    'dependency',
    'dependencies',
    '.pth',
    'python',
    'bun',
    'node.js',
    'javascript',
    'typescript',
    'developer',
    'developers',
    'repository',
    'github',
    'credential',
    'credentials',
    'api key',
    'secret key',
    'environment variable',
    'ssh key',
    'infostealer',
    'shai-hulud',
    'cyberattack',
    'cyberattacks',
    'cyber attack',
    'cyber attacks',
    'data breach',
    'breach',
    'ransomware',
    'attacks',
    'attackers',
  ]);
}

function hasExplicitCryptoSecurityRelevance(body: string): boolean {
  if (!hasAny(body, [
    'hack',
    'hacked',
    'exploit',
    'exploited',
    'phishing',
    'drained',
    'drainer',
    'bridge attack',
    'private key',
    'seed phrase',
    'wallet drain',
    'security incident',
    'vulnerability',
    'malware',
    'supply chain',
    'supply-chain',
  ])) {
    return false;
  }

  return hasAny(body, [
    'bitcoin',
    'btc',
    'ethereum',
    'eth',
    'crypto',
    'cryptocurrency',
    'blockchain',
    'defi',
    'web3',
    'wallet',
    'smart contract',
  'raydium',
  'starknet',
  'erc-20',
  'erc20',
  'bnbchain',
  'bnb chain',
  'kucoin',
  'tornado cash',
  'cross-chain bridge',
  'cross chain bridge',
  'shielded erc-20',
    'bridge',
    'protocol',
    'exchange',
    'dex',
    'dao',
    'dapp',
    'onchain',
    'on-chain',
    'token',
    'tokens',
    'stablecoin',
    'usdt',
    'usdc',
    'solana',
    'base',
    'bnb chain',
    'arbitrum',
    'optimism',
    'polygon',
    'avalanche',
    'ton',
    'ledger',
    'metamask',
    'phantom',
    'binance',
    'coinbase',
    'kraken',
    'okx',
    'bybit',
    'aave',
    'curve',
    'uniswap',
    'lending protocol',
    'liquidity pool',
    'treasury',
    'stolen funds',
    'funds stolen',
    'lost funds',
    'drained funds',
  ]);
}

function mentionsGenericAi(body: string): boolean {
  return hasAny(body, [
    'openai',
    'anthropic',
    'microsoft',
    'grok',
    'xai',
    'artificial intelligence',
  ]);
}

function mentionsGenericEquityOrSpaceX(body: string): boolean {
  return hasAny(body, [
    'spacex',
    'stock market',
    'nasdaq',
    'nyse',
    'ipo',
    'valuation',
    'shares',
    'equity',
    'wall street',
  ]);
}

function mentionsGenericGeopolitics(body: string): boolean {
  return hasAny(body, [
    'iran',
    'hormuz',
    'trump',
    'war',
    'ceasefire',
    'sanction',
    'missile',
    'geopolitical',
  ]);
}

function isEngagementBait(body: string): boolean {
  if (body.includes('place your final bets')) return true;
  if (body.includes('which') && body.includes('?') && hasAny(body, ['watching', 'choose', 'prefer', 'above', 'below'])) return true;
  if (body.includes('80k') && body.includes('50k') && body.includes('btc')) return true;
  if (body.includes('pump') && body.includes('polymarket') && body.includes('chance')) return true;
  return false;
}

function getCryptoEditorialSubstanceRejectReason(body: string): string | null {
  if (isLowSubstanceCryptoMarketCommentary(body)) {
    return 'pre_ai_low_substance_market_commentary';
  }

  return null;
}

function isLowSubstanceCryptoMarketCommentary(body: string): boolean {
  if (!mentionsCryptoMarketAnalysis(body)) return false;
  if (hasConcreteCryptoMarketSignal(body)) return false;

  // Reject vague analysis/report teasers and market commentary that only says an
  // analysis exists or "may provide clues" without giving a concrete signal.
  if (hasAny(body, VAGUE_MARKET_ANALYSIS_TEASERS)) return true;

  // Market-analysis text with only generic words like sentiment/positioning/trend
  // and no numbers, levels, flows, or directional conclusion is not publish-worthy.
  return hasAny(body, GENERIC_MARKET_ANALYSIS_TERMS);
}

function mentionsCryptoMarketAnalysis(body: string): boolean {
  return hasAny(body, [
    'market',
    'price',
    'trend',
    'technical analysis',
    'options',
    'volatility',
    'implied volatility',
    'realized volatility',
    'positioning',
    'trader positioning',
    'sentiment',
    'market sentiment',
    'support',
    'resistance',
    'breakout',
    'breakdown',
    'bounce',
    'bounced',
    'reclaim',
    'reclaimed',
    'low',
    'high',
    'glassnode',
    'santiment',
    'cryptoquant',
    'coinshares',
    'kaiko',
    'funding',
    'open interest',
    'liquidation',
    'liquidations',
  ]);
}

function hasConcreteCryptoMarketSignal(body: string): boolean {
  return hasConcreteNumericSignal(body)
    || hasAny(body, CONCRETE_MARKET_SIGNAL_TERMS)
    || hasConcreteMarketStructureSignal(body)
    || hasConcreteCryptoEventSignal(body);
}

function hasConcreteNumericSignal(body: string): boolean {
  return /(?:[$€£]\s*)?[0-9۰-۹٠-٩][0-9۰-۹٠-٩,._\s]*(?:%|percent|bps|basis points|usd|dollars?|million|billion|trillion|m\b|b\b|k\b|btc\b|eth\b|usdt\b|usdc\b)/iu.test(body)
    || /(?:above|below|over|under|near|at|from|to)\s+\$?\s*[0-9۰-۹٠-٩][0-9۰-۹٠-٩,._\s]*(?:k\b|m\b|b\b)?/iu.test(body)
    || /[0-9۰-۹٠-٩][0-9۰-۹٠-٩,._\s]*\s*(?:inflow|inflows|outflow|outflows|liquidation|liquidations|volume|open interest|funding rate)/iu.test(body);
}

function hasConcreteMarketStructureSignal(body: string): boolean {
  return /(?:breaks?|broke|reclaims?|reclaimed|holds?|held|loses?|lost|rejects?|rejected)\s+(?:above|below|over|under|at|near)\s+\$?\s*[0-9۰-۹٠-٩]/iu.test(body)
    || /(?:support|resistance)\s+(?:at|near|around)\s+\$?\s*[0-9۰-۹٠-٩]/iu.test(body)
    || /(?:implied volatility|realized volatility|open interest|funding rate|net inflows?|net outflows?)\s+(?:rose|rises|fell|falls|jumped|dropped|turned|hit|reached|increased|decreased)/iu.test(body);
}

function hasConcreteCryptoEventSignal(body: string): boolean {
  return hasAny(body, [
    'etf filing',
    'sec filing',
    's-1',
    '19b-4',
    'approved',
    'approval',
    'rejected',
    'launched',
    'launches',
    'listing',
    'listed',
    'mainnet launch',
    'token launch',
    'airdrop',
    'exploit',
    'hacked',
    'hack',
    'drained',
    'stolen funds',
    'frozen',
    'froze',
    'minted',
    'burned',
    'transferred',
    'withdrew',
    'withdrawn',
    'deposit',
    'outflow',
    'inflow',
    'charged',
    'indicted',
    'lawsuit',
    'settlement',
    'acquired',
    'raises',
    'raised',
    'partners with',
    'integrates',
  ]);
}

const VAGUE_MARKET_ANALYSIS_TEASERS = [
  'may provide clues',
  'could provide clues',
  'can provide clues',
  'offers a deeper picture',
  'provides a deeper picture',
  'deeper picture',
  'sheds light',
  'analysis includes',
  'report includes',
  'report explores',
  'we break down',
  'this analysis looks at',
  'this report looks at',
  'what traders expect',
  'expectations of future volatility',
  'expectations for future volatility',
  'short-term and medium-term trend',
  'short and medium term trend',
  'near-term and medium-term trend',
  'overall market sentiment',
  'general market sentiment',
];

const GENERIC_MARKET_ANALYSIS_TERMS = [
  'market sentiment',
  'trader positioning',
  'positioning',
  'volatility expectations',
  'future volatility',
  'short-term trend',
  'medium-term trend',
  'trend expectations',
  'technical picture',
  'market picture',
  'options data',
  'derivatives data',
];

const CONCRETE_MARKET_SIGNAL_TERMS = [
  'net inflow',
  'net inflows',
  'net outflow',
  'net outflows',
  'funding rate turned negative',
  'funding rate turned positive',
  'open interest rose',
  'open interest fell',
  'open interest hit',
  'implied volatility rose',
  'implied volatility fell',
  'implied volatility hit',
  'liquidations topped',
  'liquidations reached',
  'spot bitcoin etf inflow',
  'spot bitcoin etf outflow',
  'bitcoin etf inflow',
  'bitcoin etf outflow',
  'ethereum etf inflow',
  'ethereum etf outflow',
];

function hasCoreWhaleAsset(body: string): boolean {
  return hasAny(body, [
    'usdt',
    'usdc',
    'btc',
    'bitcoin',
    'eth',
    'ethereum',
  ]);
}


function getWhaleAlertRejectReason(body: string): string | null {
  if (body.includes('unknown wallet to unknown wallet')) return 'pre_ai_whale_unknown_to_unknown';
  if (!hasCoreWhaleAsset(body)) return 'pre_ai_whale_non_core_asset';

  const usdValue = extractWhaleUsdValue(body);

  if (isWhaleInstitutionToUnknown(body)) return 'pre_ai_whale_institution_to_unknown';

  if (isWhaleStablecoinMintOrBurn(body) && usdValue >= 100_000_000) return null;
  if (isWhaleStablecoinDefiFlow(body) && usdValue >= 100_000_000) return null;
  if (isWhaleExchangeFlow(body) && usdValue >= whaleExchangeUsdThreshold(body)) return null;

  return 'pre_ai_whale_low_signal';
}

function isWhaleInstitutionToUnknown(body: string): boolean {
  return body.includes('from coinbase institutional to unknown wallet')
    || body.includes('from coinbase insto to unknown wallet')
    || body.includes('from bitgo to unknown wallet')
    || body.includes('from custody to unknown wallet');
}

function isWhaleStablecoinMintOrBurn(body: string): boolean {
  return hasAny(body, ['usdc', 'usdt', 'tether'])
    && hasAny(body, ['minted', 'mint', 'burned', 'burnt', 'burn', 'issued', 'destroyed'])
    && hasAny(body, ['treasury', 'circle', 'tether treasury', 'usdc treasury']);
}

function isWhaleStablecoinDefiFlow(body: string): boolean {
  return hasAny(body, ['usdc', 'usdt', 'tether'])
    && hasAny(body, ['aave', 'compound', 'maker', 'curve', 'lending protocol']);
}

function isWhaleExchangeFlow(body: string): boolean {
  return hasAny(body, [
    'to binance',
    'to kraken',
    'to bitfinex',
    'to coinbase',
    'to okx',
    'to bybit',
    'to bitstamp',
    'to gemini',
    'from binance',
    'from kraken',
    'from bitfinex',
    'from coinbase',
    'from okx',
    'from bybit',
    'from bitstamp',
    'from gemini',
  ]);
}

function whaleExchangeUsdThreshold(body: string): number {
  if (hasAny(body, ['usdc', 'usdt', 'tether'])) return 100_000_000;
  if (hasAny(body, ['eth', 'ethereum'])) return 100_000_000;
  if (hasAny(body, ['btc', 'bitcoin'])) return 100_000_000;
  return 150_000_000;
}

function extractWhaleUsdValue(body: string): number {
  const values = [
    parseMagnitudeMatch(body.match(/([\d,.]+)\s*(billion|million|m|b)?\s*usd\b/i)),
    parseMagnitudeMatch(body.match(/\$\s*([\d,.]+)\s*(billion|million|m|b)?\b/i)),
    parseMagnitudeMatch(body.match(/([\d,.]+)\s*(billion|million)\s*(?:dollars|usd)\b/i)),
    parseMagnitudeMatch(body.match(/([\d,.]+)\s*(billion|million|m|b)?\s*(?:usdc|usdt|tether)\b/i)),
  ].filter(value => value > 0);

  return values.length ? Math.max(...values) : 0;
}

function parseMagnitudeMatch(match: RegExpMatchArray | null): number {
  if (!match) return 0;
  const raw = match[1];
  if (!raw) return 0;
  const value = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(value) || value <= 0) return 0;
  const unit = String(match[2] ?? '').toLowerCase();
  if (unit === 'billion' || unit === 'b') return value * 1_000_000_000;
  if (unit === 'million' || unit === 'm') return value * 1_000_000;
  return value;
}

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAccount(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^@+/, '');
}

function hasAny(body: string, terms: string[]): boolean {
  return terms.some(term => body.includes(term));
}
