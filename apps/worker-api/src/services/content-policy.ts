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
    if (body.includes('unknown wallet to unknown wallet')) return 'pre_ai_whale_unknown_to_unknown';
    if (!hasCoreWhaleAsset(body)) return 'pre_ai_whale_non_core_asset';
    if (!hasCryptoRelevance(body, account)) return 'pre_ai_non_crypto';
    return null;
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
