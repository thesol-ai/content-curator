import type { AIGateResult, NormalizedItem, TranslationOutput } from '../types';

export interface CaptionQualityDecision {
  ok: boolean;
  translation?: TranslationOutput;
  reason?: string;
}

const PROMOTIONAL_SOURCE_ACCOUNTS = new Set([
  'solana',
  'chainlink',
  'binance',
  'base',
  'ethereum',
  'ondofinance',
  'aave',
  'uniswap',
  'nansen_ai',
]);

const WATCH_SOURCE_ACCOUNTS = new Set([
  'cointelegraph',
  'watcherguru',
  'utoday_en',
  'beincrypto',
]);

export function getSourceAudienceRejectReason(
  item: Pick<NormalizedItem, 'sourceAccount' | 'text'>,
  ai?: Pick<AIGateResult, 'score' | 'topicFingerprint' | 'riskFlags' | 'publishPriority'>,
): string | null {
  const account = normalizeAccount(item.sourceAccount);
  const body = normalizeText(item.text);
  const fingerprint = normalizeText(ai?.topicFingerprint ?? '');
  const combined = `${body} ${fingerprint}`;

  if (!combined.trim()) return 'iran_audience_empty_context';

  if (isExplicitScamOrPrizeCampaign(combined)) return 'iran_audience_promotional_campaign';

  if (account === 'binance' && isExchangeMarketing(combined)) {
    return 'iran_audience_exchange_marketing';
  }

  if (PROMOTIONAL_SOURCE_ACCOUNTS.has(account)) {
    if (isProjectMarketing(combined)) return 'iran_audience_project_marketing';
    if (!hasHighSignalCryptoNews(combined)) return 'iran_audience_official_source_low_signal';
  }

  if (WATCH_SOURCE_ACCOUNTS.has(account) && isLowValueForIranianAudience(combined)) {
    return 'iran_audience_low_value_watch_source';
  }

  if (isPrivateEquityRetailAccessWithoutIranUtility(combined)) {
    return 'iran_audience_private_asset_tokenization_low_utility';
  }

  const genericRejectReason = getGenericCryptoEditorialRejectReason(account, combined, ai);
  if (genericRejectReason) return genericRejectReason;

  return null;
}

export function buildCryptoStoryClusterKey(
  topicFingerprint: unknown,
  text: unknown,
  sourceAccount?: unknown,
): string | null {
  const body = normalizeText(`${topicFingerprint ?? ''} ${text ?? ''} ${sourceAccount ?? ''}`);
  if (!body) return null;

  if (hasAll(body, ['usdt']) && (hasAny(body, ['xmr', 'monero']) || hasAny(body, ['zachxbt', 'zach xbt'])) && hasAny(body, ['tether', 'blacklist', 'freeze', 'froze', 'launder', 'money laundering', 'پولشویی'])) {
    return 'story:usdt-xmr-tether-laundering';
  }

  if (body.includes('metaplanet') && hasAny(body, ['siiibo', 'securities', 'yield', 'btc-linked', 'bitcoin yield', 'اوراق بهادار', 'محصولات مالی'])) {
    return 'story:metaplanet-bitcoin-products';
  }

  if (hasAny(body, ['bitcoin etf', 'btc etf', 'ethereum etf', 'eth etf', 'spot bitcoin etf', 'spot ethereum etf', 'etf']) && hasAny(body, ['inflow', 'outflow', 'netflow', 'net flow', 'ورودی', 'خروجی', 'جریان سرمایه'])) {
    return 'story:spot-crypto-etf-flows';
  }

  if (hasAny(body, ['spacex', 'spcx', 'spcxb']) && hasAny(body, ['tokenized', 'tokenization', 'stocks', 'shares', 'bstocks', 'ipo', 'stock', 'سهام', 'توکنیزه'])) {
    return 'story:spacex-tokenized-equity';
  }

  if (hasAny(body, ['securitize', 'stac', 'ethena', 'clo', 'jaaa', 'janus henderson']) && hasAny(body, ['solana', 'tokenized', 'tokenization', 'rwa', 'onchain', 'clo'])) {
    return 'story:tokenized-clo-solana';
  }

  if (body.includes('hyperliquid') && hasAny(body, ['circle', 'coinbase', 'usdc']) && hasAny(body, ['4.4', '4.397', 'billion', 'treasury', 'transfer'])) {
    return 'story:circle-coinbase-hyperliquid-usdc';
  }

  if (hasAny(body, ['clarity act', 'crypto clarity', 'قانون شفافیت']) && hasAny(body, ['july 4', '4 july', '۴ جولای', 'کاخ سفید', 'white house'])) {
    return 'story:us-crypto-clarity-act-deadline';
  }

  if (body.includes('blockworks') && body.includes('messari')) return 'story:blockworks-messari-acquisition';

  return null;
}

export function buildCryptoThemeKey(topicFingerprint: unknown, text: unknown, sourceAccount?: unknown): string | null {
  const body = normalizeText(`${topicFingerprint ?? ''} ${text ?? ''} ${sourceAccount ?? ''}`);
  if (!body) return null;

  if (hasAny(body, ['tokenized', 'tokenization', 'rwa', 'real-world asset', 'real world asset', 'onchain']) && hasAny(body, ['stock', 'stocks', 'shares', 'equity', 'clo', 'fund', 'securities', 'private assets', 'سهام', 'دارایی واقعی'])) {
    return 'theme:rwa-tokenized-assets';
  }

  if (hasAny(body, ['etf', 'bitcoin etf', 'ethereum etf', 'spot etf']) && hasAny(body, ['inflow', 'outflow', 'filing', '8-a', 's-1', '19b-4', 'launch', 'approval', 'ورودی', 'خروجی'])) {
    return 'theme:crypto-etf';
  }

  if (hasAny(body, ['hack', 'exploit', 'phishing', 'stolen', 'launder', 'blacklist', 'freeze', 'froze', 'security incident', 'هک', 'پولشویی', 'مسدود'])) {
    return 'theme:security-exploit';
  }

  return null;
}

export function getCryptoThemeDailyCap(themeKey: string | null): number | null {
  switch (themeKey) {
    case 'theme:rwa-tokenized-assets': return 2;
    case 'theme:crypto-etf': return 2;
    case 'theme:security-exploit': return 3;
    default: return null;
  }
}

export function applyPersianCaptionQualityGuard(
  language: string,
  translation: TranslationOutput,
  sourceText: unknown,
): CaptionQualityDecision {
  if (language !== 'fa') return { ok: true, translation };

  const cleaned: TranslationOutput = {
    ...translation,
    captionShort: repairPersianCaptionText(translation.captionShort),
    captionFull: repairPersianCaptionText(translation.captionFull),
    hashtags: translation.hashtags,
  };

  const combinedCaption = `${cleaned.captionShort}\n${cleaned.captionFull}`;
  if (hasYearMismatch(sourceText, combinedCaption)) {
    return { ok: false, reason: 'caption_year_mismatch' };
  }

  if (hasForbiddenPersianGenericAdvice(combinedCaption)) {
    return { ok: false, reason: 'caption_generic_investment_advice' };
  }

  return { ok: true, translation: cleaned };
}

export function repairPersianCaptionText(value: string): string {
  let out = String(value ?? '');

  const replacements: Array<[RegExp, string]> = [
    [/میلیوندلار/g, 'میلیون دلار'],
    [/میلیارددلار/g, 'میلیارد دلار'],
    [/پولشوییمرتبط/g, 'پولشویی مرتبط'],
    [/حوزهدارایی/g, 'حوزه دارایی'],
    [/اینفناوری/g, 'این فناوری'],
    [/تاثیرگذاشته/g, 'تأثیر گذاشته'],
    [/تاثیرگذار/g, 'تأثیرگذار'],
    [/می‌تواندتوجه/g, 'می‌تواند توجه'],
    [/اتفاقاتبر/g, 'اتفاقات بر'],
    [/داردارائه/g, 'دارد ارائه'],
    [/دارداوراق/g, 'دارد اوراق'],
    [/می‌دهدکه/g, 'می‌دهد که'],
  ];

  for (const [pattern, replacement] of replacements) out = out.replace(pattern, replacement);

  out = out
    .replace(/([\p{Script=Arabic}])([A-Za-z0-9$@#])/gu, '$1 $2')
    .replace(/([A-Za-z0-9])([\p{Script=Arabic}])/gu, '$1 $2')
    .replace(/\s+([،؛:,.!?؟])/g, '$1')
    .replace(/([،؛:,.!?؟])([^\s\n])/g, '$1 $2')
    .replace(/([0-9۰-۹٠-٩])\.\s+([0-9۰-۹٠-٩])/g, '$1.$2')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return out;
}

function hasYearMismatch(sourceText: unknown, caption: string): boolean {
  const src = normalizeDigits(String(sourceText ?? '')).toLowerCase();
  const cap = normalizeDigits(caption).toLowerCase();

  const sourceYears = new Set(Array.from(src.matchAll(/\b20[0-9]{2}\b/g)).map(m => m[0]));
  if (sourceYears.size === 0) return false;

  if (sourceYears.has('2026') && cap.includes('2024')) return true;
  if (sourceYears.has('2026') && cap.includes('2025') && !src.includes('2025')) return true;
  if (sourceYears.has('2025') && cap.includes('2024') && !src.includes('2024')) return true;

  return false;
}

function hasForbiddenPersianGenericAdvice(text: string): boolean {
  const body = normalizeText(text);
  return body.includes('سرمایه گذاران نباید') || body.includes('سرمایه‌گذاران نباید') || body.includes('سیگنالی برای تحرکات آتی');
}

function isExplicitScamOrPrizeCampaign(body: string): boolean {
  return hasAny(body, [
    'competition', 'contest', 'voucher', 'vouchers', 'claim your share', "don't miss out", 'airdrop', 'rewards', 'reward campaign',
    'مسابقه', 'جایزه', 'ایردراپ', 'سهمی از جوایز',
  ]);
}

function isExchangeMarketing(body: string): boolean {
  return hasAny(body, ['trading competition', 'token vouchers', 'claim your share', 'now live until', 'trade tokenized stocks', 'مسابقه معاملاتی']);
}

function isProjectMarketing(body: string): boolean {
  return hasAny(body, [
    'is live on', 'powered by', "here's where to get access", 'get access', 'ecosystem news', 'integration', 'integrations',
    'now live', 'launch campaign', 'announcing', 'powered', 'markets for btc', 'chainlink =',
    'بر بستر شبکه', 'امکان دسترسی', 'با استفاده از اوراکل', 'راه اندازی شد', 'راه‌اندازی شد',
  ]) && !hasAny(body, ['exploit', 'hack', 'outage', 'security incident', 'governance vote', 'mainnet upgrade', 'regulatory', 'sec', 'cftc']);
}

function hasHighSignalCryptoNews(body: string): boolean {
  return hasAny(body, [
    'exploit', 'hack', 'stolen', 'blacklist', 'freeze', 'froze', 'sec', 'cftc', 'lawsuit', 'settlement',
    'etf filing', 'approved', 'approval', 'mainnet upgrade', 'governance', 'outage', 'listing announcement',
    'liquidation', 'net inflow', 'net outflow', 'treasury', 'reserve', 'reserves', 'billion', 'million',
    'هک', 'پولشویی', 'مسدود', 'قانون', 'کمیسیون', 'etf', 'صندوق', 'میلیون', 'میلیارد',
  ]);
}

function isLowValueForIranianAudience(body: string): boolean {
  if (hasAny(body, ['private assets like openai and spacex', 'retail access to private assets', 'watch the full interview'])) return true;
  if (hasAny(body, ['canary in the macro coal mine']) && !hasAny(body, ['bitcoin etf', 'liquidation', 'funding rate', 'inflow', 'outflow'])) return true;
  return false;
}

function isPrivateEquityRetailAccessWithoutIranUtility(body: string): boolean {
  // Do not override the existing crypto/RWA allow policy. These can still be
  // rejected later by story/theme caps or source marketing checks, but the
  // generic Iranian-audience gate must not swallow all tokenized-equity news.
  if (hasAny(body, ['crypto platforms', 'rwa rails', 'rwa markets', 'tokenized equity'])) {
    return false;
  }

  return hasAny(body, [
    'private assets like openai and spacex',
    'retail access to private assets',
    'watch the full interview',
  ]) && !hasAny(body, [
    'sec',
    'cftc',
    'enforcement',
    'approved',
    'filing',
    'listing',
    'lawsuit',
    'exploit',
    'security',
    'rwa',
    'tokenized equity',
    'crypto platforms',
  ]);
}

export function getGenericCryptoEditorialRejectReason(
  sourceAccount: unknown,
  text: unknown,
  ai?: Pick<AIGateResult, 'score' | 'topicFingerprint' | 'riskFlags' | 'publishPriority'>,
): string | null {
  const account = normalizeAccount(sourceAccount);
  const body = normalizeText(text);
  const score = Number(ai?.score ?? NaN);

  if (!body) return 'iran_audience_empty_context';

  if (
    hasAny(body, ['cancelled', 'canceled'])
    && hasAny(body, ['crypto platforms', 'tokenized', 'tokenized equity', 'rwa', 'rwa markets'])
    && hasAny(body, ['product', 'market', 'markets', 'equity'])
  ) {
    return null;
  }

  if (isEvergreenInterviewOrExplainer(body) && !hasMaterialCryptoImpact(body)) {
    return 'iran_audience_evergreen_or_interview_low_utility';
  }

  if (isGenericMarketingOrCampaignLanguage(body) && !hasMaterialCryptoImpact(body)) {
    return 'iran_audience_generic_marketing_or_campaign';
  }

  if (isLowUtilityProductAccessStory(body) && !hasMaterialCryptoImpact(body)) {
    return 'iran_audience_low_utility_product_access';
  }

  if (isSoftSpeculationWithoutEvidence(body)) {
    return 'iran_audience_soft_speculation_without_evidence';
  }

  if (isProtocolOrProjectUpdate(body) && !hasMaterialCryptoImpact(body)) {
    return 'iran_audience_project_update_without_material_impact';
  }

  if ((PROMOTIONAL_SOURCE_ACCOUNTS.has(account) || WATCH_SOURCE_ACCOUNTS.has(account))
    && Number.isFinite(score)
    && score < 85
    && !hasMaterialCryptoImpact(body)) {
    return 'iran_audience_watch_source_requires_material_impact';
  }

  return null;
}

function hasMaterialCryptoImpact(body: string): boolean {
  return hasAny(body, [
    'hack', 'hacked', 'exploit', 'exploited', 'stolen', 'drained', 'blacklist', 'freeze', 'froze',
    'security incident', 'vulnerability', 'phishing', 'private key', 'seed phrase', 'wallet drained',
    'sec', 'cftc', 'regulator', 'regulatory', 'lawsuit', 'settlement', 'charged', 'indicted',
    'approved', 'approval', 'filing', 's-1', '19b-4', 'listing announcement', 'delisting',
    'mainnet upgrade', 'outage', 'governance vote', 'hard fork', 'exploit fix',
    'net inflow', 'net outflow', 'inflow', 'outflow', 'liquidation', 'liquidations',
    'open interest', 'funding rate', 'exchange reserves', 'minted', 'burned', 'treasury',
    'reserve', 'reserves', 'billion', 'million', '$', '%',
    'هک', 'سرقت', 'پولشویی', 'مسدود', 'مسدودسازی', 'قانون', 'رگولاتوری', 'کمیسیون',
    'شکایت', 'تسویه', 'تأیید', 'پرونده', 'لیست شدن', 'نقدینگی', 'لیکویید',
    'ورودی', 'خروجی', 'ذخایر', 'خزانه', 'میلیون', 'میلیارد',
  ]) || /(?:[$€£]\s*)?[0-9۰-۹٠-٩][0-9۰-۹٠-٩,._\s]*(?:%|percent|bps|million|billion|trillion|m|b|k|btc|eth|usdt|usdc)/iu.test(body);
}

function isGenericMarketingOrCampaignLanguage(body: string): boolean {
  return hasAny(body, [
    'now live', 'is live', 'goes live', 'powered by', 'get access', 'join now', 'start trading',
    'trade now', 'limited time', 'campaign', 'contest', 'competition', 'voucher', 'reward',
    'rewards', 'claim', 'claim your share', "don't miss out", 'learn more', 'full interview',
    'watch the full interview', 'ecosystem news', 'integration is live', 'partnership is live',
    'اکنون فعال', 'هم اکنون فعال', 'دسترسی پیدا کنید', 'کمپین', 'مسابقه', 'جایزه', 'پاداش',
  ]);
}

function isLowUtilityProductAccessStory(body: string): boolean {
  return hasAny(body, [
    'private assets', 'retail access', 'tokenized stocks', 'pre-ipo', 'pre ipo',
    'synthetic stock', 'stock token', 'tokenized shares', 'trade tokenized',
    'direct stock offering', 'equity product', 'private shares',
    'دارایی خصوصی', 'سهام خصوصی', 'سهام توکنیزه', 'عرضه سهام',
  ]);
}

function isEvergreenInterviewOrExplainer(body: string): boolean {
  return hasAny(body, [
    'what is', 'how to', 'guide', 'explainer', 'thread', 'opinion', 'interview', 'podcast',
    'watch:', 'watch ', 'read more', 'deep dive', 'we break down', 'everything you need to know',
    'راهنما', 'مصاحبه', 'پادکست', 'همه چیز درباره', 'بررسی می کنیم',
  ]);
}

function isSoftSpeculationWithoutEvidence(body: string): boolean {
  if (hasMaterialCryptoImpact(body)) return false;
  return hasAny(body, [
    'could signal', 'may signal', 'might signal', 'could indicate', 'may indicate', 'could pave the way',
    'potentially', 'potential for', 'suggests growing interest', 'shows growing adoption',
    'canary in the macro coal mine', 'could be huge', 'bullish', 'bearish',
    'می تواند نشان دهنده', 'می تواند زمینه ساز', 'پتانسیل', 'نشانه ای از رشد پذیرش',
  ]);
}

function isProtocolOrProjectUpdate(body: string): boolean {
  return hasAny(body, [
    'supports', 'adds support', 'integrates', 'integration', 'partners with', 'partnership',
    'launches on', 'available on', 'deployed on', 'built on', 'powered by',
    'پشتیبانی از', 'یکپارچه سازی', 'همکاری با', 'روی شبکه', 'بر بستر',
  ]);
}

function normalizeAccount(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/^@+/, '');
}

function normalizeText(value: unknown): string {
  return normalizeDigits(String(value ?? ''))
    .toLowerCase()
    .replace(/[\u200c\u200d]/g, ' ')
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDigits(value: string): string {
  const fa = '۰۱۲۳۴۵۶۷۸۹';
  const ar = '٠١٢٣٤٥٦٧٨٩';
  return String(value ?? '').replace(/[۰-۹٠-٩]/g, ch => {
    const faIndex = fa.indexOf(ch);
    if (faIndex >= 0) return String(faIndex);
    const arIndex = ar.indexOf(ch);
    if (arIndex >= 0) return String(arIndex);
    return ch;
  });
}

function hasAny(body: string, needles: string[]): boolean {
  return needles.some(needle => body.includes(needle.toLowerCase()));
}

function hasAll(body: string, needles: string[]): boolean {
  return needles.every(needle => body.includes(needle.toLowerCase()));
}
