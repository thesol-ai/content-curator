import type { AIGateResult, CategoryRow, NormalizedItem } from '../types';

export function findSimilarTopicInRunRejections(
  items: Pick<NormalizedItem, 'sourceAccount'>[],
  aiResults: Pick<AIGateResult, 'publish' | 'riskLevel' | 'score' | 'topicFingerprint'>[],
  scoreThreshold: number,
): Set<number> {
  const groups = new Map<string, Array<{ index: number; score: number }>>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const ai = aiResults[i];
    if (!item || !ai) continue;
    if (!isAiPublishEligible(ai, scoreThreshold)) continue;

    const fingerprint = normalizeSemanticKeyPart(ai.topicFingerprint);
    if (!fingerprint) continue;

    const key = fingerprint;
    const group = groups.get(key) ?? [];
    group.push({ index: i, score: Number(ai.score) || 0 });
    groups.set(key, group);
  }

  const rejected = new Set<number>();
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    const [winner, ...rest] = group
      .slice()
      .sort((a, b) => (b.score - a.score) || (a.index - b.index));
    void winner;
    for (const candidate of rest) rejected.add(candidate.index);
  }
  return rejected;
}

export function getPreAiContentRejectReason(item: NormalizedItem, category: CategoryRow): string | null {
  if (item.isReply === true && intSetting(category.allow_replies, 0) === 0) return 'reply_not_allowed';
  if (item.isRetweet === true && intSetting(category.allow_retweets, 1) === 0) return 'retweet_not_allowed';
  if (item.isQuote === true && intSetting(category.allow_quotes, 1) === 0) return 'quote_not_allowed';
  const textOnlyPolicy = sanitizeTextOnlyPolicy(category.text_only_policy);
  if (category.media_mode !== 'disabled' && item.media.length === 0 && textOnlyPolicy === 'reject') return 'text_only_rejected';

  if (String(category.id ?? '').trim().toLowerCase() === 'crypto') {
    return getCryptoPreAiRejectReason(item);
  }

  return null;
}

export function getItemRejectReason(ai: AIGateResult, category: CategoryRow, item: NormalizedItem, similarTopicInRun: boolean): string | null {
  if (similarTopicInRun) return 'similar_topic_in_run';
  if (!ai.publish) return 'ai_not_publish';
  if (ai.riskLevel === 'high') return 'high_risk';
  if (ai.score < category.score_threshold) return 'below_threshold';

  const textOnlyPolicy = sanitizeTextOnlyPolicy(category.text_only_policy);
  if (category.media_mode !== 'disabled' && item.media.length === 0) {
    const minTextOnly = Number(category.min_score_for_text_only);
    if (textOnlyPolicy === 'penalize' && Number.isFinite(minTextOnly) && ai.score < minTextOnly) return 'text_only_below_min_score';
  }
  if (item.media.length > 0) {
    const minMedia = Number(category.min_score_for_media);
    if (Number.isFinite(minMedia) && ai.score < minMedia) return 'media_below_min_score';
  }
  return null;
}

export function buildPolicyRejectAiResult(item: NormalizedItem, reason: string): AIGateResult {
  return {
    publish: false,
    score: 0,
    riskLevel: 'medium',
    riskFlags: [reason],
    topicFingerprint: `policy-${item.postId}`.slice(0, 100),
    publishPriority: 'low',
    translations: {},
  };
}


function getCryptoPreAiRejectReason(item: NormalizedItem): string | null {
  const body = normalizeText(item.text);
  const account = normalizeAccount(item.sourceAccount);

  if (!body) return 'pre_ai_empty_text';
  if (isEngagementBait(body)) return 'pre_ai_engagement_bait';

  if (account === 'whale_alert') {
    return getWhaleAlertRejectReason(body);
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

  return null;
}

function hasCryptoRelevance(body: string, account: string): boolean {
  if (hasAny(body, DIRECT_CRYPTO_ANCHORS)) return true;

  const etfAccounts = new Set([
    'ericbalchunas',
    'jseyff',
    'nategeraci',
    'eleanorterrett',
  ]);

  if (etfAccounts.has(account) && hasAny(body, ETF_REGULATORY_TERMS)) return true;

  const cryptoNativeAccounts = new Set([
    'coindesk',
    'cointelegraph',
    'theblock__',
    'wublockchain',
    'watcherguru',
    'news_of_alpha',
    'tree_of_alpha',
    'bitcoinmagazine',
    'defiantnews',
    'dlnewsinfo',
    'lookonchain',
    'glassnode',
    'cryptoquant_com',
    'zachxbt',
    'peckshieldalert',
    'slowmist_team',
    'cyversalerts',
    'defillama',
    'banklesshq',
    'thedefiantnews',
    'ethereum',
    'solana',
    'base',
    'chainlink',
    'coinbaseassets',
    'binance',
  ]);

  if (cryptoNativeAccounts.has(account) && hasAny(body, CRYPTO_NATIVE_CONTEXT_TERMS)) return true;

  return false;
}

const DIRECT_CRYPTO_ANCHORS = [
  'bitcoin',
  'btc',
  '$btc',
  'ethereum',
  'eth',
  '$eth',
  'crypto',
  'cryptocurrency',
  'blockchain',
  'digital asset',
  'digital-asset',
  'tokenized',
  'tokenization',
  ' token ',
  ' tokens ',
  'rwa',
  'stablecoin',
  'usdt',
  'tether',
  'usdc',
  'defi',
  'onchain',
  'on-chain',
  'whale',
  'wallet',
  'exchange',
  'coinbase',
  'binance',
  'kraken',
  'bybit',
  'bitget',
  'okx',
  'mexc',
  'dex',
  'smart contract',
  'protocol',
  'web3',
  'layer 1',
  'layer-1',
  'layer 2',
  'layer-2',
  'mainnet',
  'testnet',
  'airdrop',
  'tge',
  'listing',
  'solana',
  'chainlink',
  'base',
  'ton',
  'telegram mini',
  'notcoin',
  'dogs',
  'hamster kombat',
  'spot bitcoin etf',
  'bitcoin etf',
  'ethereum etf',
  'crypto etf',
  'sec crypto',
  'cftc',
  'clarity act',
  'stablecoin bill',
  'hack',
  'exploit',
  'phishing',
  'bridge attack',
  'private key',
  'seed phrase',
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


function isAiPublishEligible(
  ai: Pick<AIGateResult, 'publish' | 'riskLevel' | 'score'>,
  scoreThreshold: number,
): boolean {
  return ai.publish === true && ai.riskLevel !== 'high' && Number(ai.score) >= scoreThreshold;
}

function normalizeSemanticKeyPart(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/\s+/g, ' ')
    .slice(0, 140);
}

function intSetting(value: unknown, defaultValue: 0 | 1): 0 | 1 {
  return value === 0 || value === '0' || value === false ? 0 : value === 1 || value === '1' || value === true ? 1 : defaultValue;
}

function sanitizeTextOnlyPolicy(value: unknown): 'allow' | 'penalize' | 'reject' {
  const raw = String(value ?? 'allow').trim().toLowerCase();
  return raw === 'penalize' || raw === 'reject' ? raw : 'allow';
}
