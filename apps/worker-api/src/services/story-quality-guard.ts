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
  opts?: { repairEnabled?: boolean; rejectEnabled?: boolean; minScore?: number; categoryId?: string },
): CaptionQualityDecision {
  if (language !== 'fa') return { ok: true, translation };

  const cleaned: TranslationOutput = {
    ...translation,
    captionShort: repairPersianCaptionText(translation.captionShort),
    captionFull: repairPersianCaptionText(translation.captionFull),
    hashtags: translation.hashtags,
  };

  // Phase 6G fix: if the caption is informative (has a concrete signal) but ends
  // with a pure-filler clause, strip ONLY that trailing clause instead of
  // rejecting the whole post. Keeps volume while removing the cliché tail.
  const repaired = stripTrailingFillerClauses(cleaned);

  const combinedCaption = `${repaired.captionShort}\n${repaired.captionFull}`;
  if (!hasPersianFirstRealWord(repaired.captionShort) || !hasPersianFirstRealWord(repaired.captionFull)) {
    return { ok: false, reason: 'caption_non_persian_lead' };
  }

  if (hasYearMismatch(sourceText, combinedCaption)) {
    return { ok: false, reason: 'caption_year_mismatch' };
  }

  if (hasForbiddenPersianGenericAdvice(combinedCaption)) {
    return { ok: false, reason: 'caption_generic_investment_advice' };
  }

  if (opts?.rejectEnabled && isCryptoCaptionQualityMode(opts) && hasForbiddenCryptoCaptionMetaLanguage(combinedCaption)) {
    return { ok: false, reason: 'caption_crypto_meta_or_audience_addressing' };
  }

  // Reject only when filler remains AND there is still no concrete signal (i.e.
  // the caption was filler through-and-through, not merely filler-tailed).
  if (hasBannedGenericFiller(combinedCaption) && !captionHasConcreteSignal(combinedCaption)) {
    return { ok: false, reason: 'caption_generic_filler' };
  }

  if (opts?.rejectEnabled && isCryptoCaptionQualityMode(opts) && hasVaguePersianEditorialLanguage(combinedCaption)) {
    return { ok: false, reason: 'caption_vague_or_formal' };
  }

  // Phase 6G: factual grounding — if the caption introduces currency/percent
  // figures and NOT ONE of them appears in the source, treat it as fabricated.
  if (hasFullyUngroundedFigures(sourceText, combinedCaption)) {
    return { ok: false, reason: 'caption_unsupported_figure' };
  }

  // Phase-next caption quality (repair-first). Repair already happened above
  // (filler-tail stripped). When repair mode is on and the repaired caption is
  // still below the bar AND reject is enabled, drop it as caption_quality_low.
  if (opts?.repairEnabled) {
    const combined = `${repaired.captionShort ?? ''}\n${repaired.captionFull ?? ''}`.trim();
    const q = scoreCaptionQuality(combined, sourceText);
    if (opts.rejectEnabled && q.score < (opts.minScore ?? 70)) {
      return { ok: false, reason: 'caption_quality_low' };
    }
  }

  return { ok: true, translation: repaired };
}


function normalizePersianCaptionSpacing(text: string): string {
  let out = String(text ?? '');

  const digit = '[۰-۹٠-٩0-9]';
  const number = `${digit}[۰-۹٠-٩0-9.,٫٬]*`;

  // Persian letters only. Do not use \p{Script=Arabic} here because Persian digits
  // are also Arabic-script and broad splitting can damage numeric expressions.
  const persianLetter = '[اآبپتثجچحخدذرزژسشصضطظعغفقکگلمنوهیئءأإؤۀة]';

  const cryptoTickers = [
    'BTC', 'ETH', 'USDT', 'USDC', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'TON',
    'TRX', 'AVAX', 'LINK', 'DOT', 'MATIC', 'POL', 'ARB', 'OP', 'LTC', 'BCH',
    'UNI', 'AAVE', 'SUI', 'APT', 'SEI', 'INJ', 'NEAR', 'ATOM', 'FIL',
  ].join('|');

  const financeLatin = [
    'ETF', 'ETFs', 'USD', 'EUR', 'GBP', 'APY', 'APR', 'TVL', 'DeFi', 'NFT',
    'CEX', 'DEX', 'L2', 'Layer2',
  ].join('|');

  const persianUnits = [
    'دلار', 'تومان', 'ریال', 'یورو', 'درهم', 'لیر', 'پوند',
    'درصد', 'واحد', 'توکن', 'کوین', 'بیت‌کوین', 'اتریوم',
  ].join('|');

  const magnitudes = [
    'هزار', 'میلیون', 'میلیارد', 'تریلیون',
  ].join('|');

  // Space after Persian/Latin punctuation, but do not split decimal numbers.
  out = out.replace(/([،؛:؛!?؟])(?=[^\s\n])/g, '$1 ');
  out = out.replace(/([.])(?=[^\s\n0-9۰-۹٠-٩])/g, '$1 ');
  out = out.replace(/([,])(?=[^\s\n0-9۰-۹٠-٩])/g, '$1 ');

  // Persian letter glued to a number.
  // Example: رشد۲۰درصدی -> رشد ۲۰ درصدی
  out = out.replace(new RegExp(`(${persianLetter})(${digit})`, 'g'), '$1 $2');

  // Number glued to Persian magnitude/unit/currency.
  // Examples: ۱۴۴.۶۸میلیون -> ۱۴۴.۶۸ میلیون
  // ۴۵.۶درصد -> ۴۵.۶ درصد
  out = out.replace(
    new RegExp(`(${number})(?=(${magnitudes}|${persianUnits}))`, 'g'),
    '$1 ',
  );

  // Number glued to crypto ticker / Latin finance term.
  // Examples: ۲۳۴۱BTC -> ۲۳۴۱ BTC
  // ۷۳۷.۷USDT -> ۷۳۷.۷ USDT
  out = out.replace(
    new RegExp(`(${number})(?=(${cryptoTickers}|${financeLatin})(?![A-Za-z0-9]))`, 'g'),
    '$1 ',
  );

  // Persian magnitude glued to currency/token.
  // Examples: میلیوندلار -> میلیون دلار
  // میلیاردتومان -> میلیارد تومان
  // هزارBTC -> هزار BTC
  out = out.replace(
    new RegExp(`(${magnitudes})(?=(${persianUnits}))`, 'g'),
    '$1 ',
  );

  out = out.replace(
    new RegExp(`(${magnitudes})(?=(${cryptoTickers}|${financeLatin})(?![A-Za-z0-9]))`, 'g'),
    '$1 ',
  );

  // Persian unit/currency glued to crypto ticker / finance Latin term.
  // Examples: دلارUSDT -> دلار USDT
  // بیت‌کوینETF -> بیت‌کوین ETF
  // اتریومETF -> اتریوم ETF
  out = out.replace(
    new RegExp(`(${persianUnits})(?=(${cryptoTickers}|${financeLatin})(?![A-Za-z0-9]))`, 'g'),
    '$1 ',
  );

  // Conservative Persian connector repairs.
  // These are common LLM spacing defects, not broad word splitting.
  out = out.replace(/حاکیاز/g, 'حاکی از');
  out = out.replace(/ناشیاز/g, 'ناشی از');
  out = out.replace(/مبتنیبر/g, 'مبتنی بر');
  out = out.replace(/مرتبطبا/g, 'مرتبط با');
  out = out.replace(/وابستهبه/g, 'وابسته به');
  out = out.replace(/منجربه/g, 'منجر به');
  out = out.replace(/اشارهبه/g, 'اشاره به');
  out = out.replace(/نسبتبه/g, 'نسبت به');
  out = out.replace(/درمقایسهبا/g, 'در مقایسه با');

  // Common verb + conjunction glue in generated Persian.
  out = out.replace(
    /(است|بود|شد|شده|رسید|رسیده|می‌دهد|می‌کند|کرده|دارد)(?=(که|اما|ولی|و)(?:\s|$))/g,
    '$1 ',
  );

  // Safety net: undo accidental spacing inside decimal numbers.
  out = out.replace(/([0-9۰-۹٠-٩])\.\s+([0-9۰-۹٠-٩])/g, '$1.$2');
  out = out.replace(/([0-9۰-۹٠-٩])٫\s+([0-9۰-۹٠-٩])/g, '$1٫$2');

  // Normalize spaces without flattening paragraphs.
  out = out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return out;
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

  return normalizePersianCaptionSpacing(out);
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

function hasForbiddenCryptoCaptionMetaLanguage(text: string): boolean {
  const body = normalizeText(text);
  return [
    'برای کاربران کریپتو',
    'برای کاربر کریپتو',
    'برای کاربران',
    'برای معامله گران',
    'برای فعالان بازار',
    'نکته مهم این است',
    'معنی ساده اش',
    'به زبان ساده',
    'این خبر از جنس',
    'این خبر بیشتر درباره',
    'این خبر نشان می دهد',
    'این موضوع نشان می دهد',
    'اگر این مدل ها',
    'نه فقط معامله کوتاه مدت',
    'نه صرفا معامله',
    'یکی از کاربردهای واقعی',
    'یکی از کاربردهای جدی',
    'فقط یک ایده حاشیه ای',
  ].some(phrase => body.includes(phrase));
}

// Phase 6G/6I: banned generic filler STEMS (normalized, ZWNJ/space-insensitive).
// Stems (not full phrases) so production variants are caught, e.g.
// "نشان‌دهنده پذیرش دارایی‌های سنتی" and "نشان‌دهنده افزایش تمرکز نهادها"
// (both observed in real published captions) match "نشان دهنده".
const BANNED_GENERIC_FILLER_PHRASES = [
  'نشان دهنده پذیرش',
  'نشان دهنده افزایش',
  'نشان دهنده تغییرات',
  'نشان دهنده بلوغ',
  'نشان دهنده اهمیت',
  'گامی در جهت',
  'گامی مهم در',
  'می تواند تاثیرگذار باشد',
  'می تواند تاثیر بگذارد',
  'پتانسیل دموکراتیزه کردن',
  'نشانه ای از رشد پذیرش',
  'یکی از بزرگترین رویدادهای',
  'محسوب می شود',
];

function hasBannedGenericFiller(text: string): boolean {
  const body = normalizeText(text);
  return BANNED_GENERIC_FILLER_PHRASES.some(p => body.includes(p));
}

function isCryptoCaptionQualityMode(opts?: { categoryId?: string }): boolean {
  return String(opts?.categoryId ?? '').trim().toLowerCase() === 'crypto';
}

function hasVaguePersianEditorialLanguage(text: string): boolean {
  const body = normalizeText(text);
  return hasAny(body, [
    'نشان دهنده',
    'اهمیت ویژه ای دارد',
    'اهمیت زیادی دارد',
    'چارچوب های قانونی',
    'شفاف سازی چارچوب',
    'چارچوب نظارتی',
    'چارچوب حقوقی',
    'تغییر رویکرد مدیریت فعال',
    'مدیریت فعال',
    'حاکی از آن است',
    'در راستای',
    'با هدف شفاف سازی',
    'نقطه عطف',
    'فضای قانون گذاری',
    'تاثیر قابل توجهی',
    'نقش مهمی ایفا',
  ]);
}

function hasPersianFirstRealWord(text: unknown): boolean {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return true;
  const withoutEmojiAndPunct = trimmed.replace(/^[\s\p{Extended_Pictographic}\uFE0F\u200C\u200D"'“”‘’«»()[\]{}<>.,:;،؛.!?؟\-–—_+*=|\\/@#$]+/u, '');
  const first = withoutEmojiAndPunct.match(/^[^\s]+/u)?.[0] ?? '';
  return Boolean(first && /\p{Script=Arabic}/u.test(first[0] ?? ''));
}

// ── Phase-next (observe-only): deterministic caption-quality score ──
// Pure, no AI call, never rejects on its own. Lets a report flag dull/risky
// captions so the operator can audit real output before tightening anything.
export interface CaptionQualityScore {
  clarity: number;            // 0..100
  sourceGrounding: number;    // 0..100 (share of caption figures present in source)
  telegramNative: number;     // 0..100 (length/structure heuristic)
  boringOrGeneric: boolean;
  unsupportedClaim: boolean;
  vagueOrFormal: boolean;
  nonPersianLead: boolean;
  score: number;              // 0..100 overall
}

export function scoreCaptionQuality(caption: unknown, sourceText: unknown = ''): CaptionQualityScore {
  const text = String(caption ?? '').trim();
  const src = String(sourceText ?? '');
  const len = text.length;

  const boringOrGeneric = hasBannedGenericFiller(text);
  const unsupportedClaim = hasFullyUngroundedFigures(src, text);
  const vagueOrFormal = hasVaguePersianEditorialLanguage(text);
  const nonPersianLead = !hasPersianFirstRealWord(text);

  // grounding: fraction of caption currency/percent figures found in source.
  const figs = extractGroundableFigureCores(text);
  const srcDigits = normalizeDigits(src).replace(/[,،]/g, '');
  let grounded = 0;
  for (const f of figs) if (srcDigits.includes(f)) grounded++;
  const sourceGrounding = figs.length === 0 ? 100 : Math.round((grounded / figs.length) * 100);

  // telegram-native: reward 120..320 chars, penalise very short/very long.
  const telegramNative = len < 60 ? 30 : len <= 320 ? 100 : len <= 500 ? 70 : 40;

  // clarity: penalise filler and a missing concrete signal.
  let clarity = 100;
  if (boringOrGeneric) clarity -= 35;
  if (vagueOrFormal) clarity -= 25;
  if (nonPersianLead) clarity -= 40;
  if (!captionHasConcreteSignal(text)) clarity -= 30;
  clarity = Math.max(0, clarity);

  const score = Math.round(
    0.35 * clarity + 0.30 * sourceGrounding + 0.20 * telegramNative + (unsupportedClaim ? 0 : 15),
  );
  return { clarity, sourceGrounding, telegramNative, boringOrGeneric, unsupportedClaim, vagueOrFormal, nonPersianLead, score: Math.min(100, score) };
}

/**
 * Phase 6G: remove a trailing sentence that is pure cliché filler (contains a
 * banned stem AND carries no concrete signal of its own), keeping the factual
 * sentences. Conservative: only strips a FINAL sentence, never the only
 * sentence, and at most twice. Operates on both captionShort and captionFull.
 */
function stripTrailingFillerClauses(t: TranslationOutput): TranslationOutput {
  return {
    ...t,
    captionShort: stripTrailingFillerFromText(t.captionShort),
    captionFull: stripTrailingFillerFromText(t.captionFull),
  };
}

function stripTrailingFillerFromText(text: unknown): string {
  let body = String(text ?? '');
  for (let pass = 0; pass < 2; pass++) {
    const sentences = body.split(/(?<=[.!؟۔])\s+/).filter(s => s.trim().length > 0);
    if (sentences.length <= 1) break;
    const last = sentences[sentences.length - 1]!;
    const isFiller = hasBannedGenericFiller(last) && !captionHasConcreteSignal(last);
    if (!isFiller) break;
    sentences.pop();
    body = sentences.join(' ').trim();
  }
  return body;
}

/** Caption carries its own concrete signal: a figure, $, %, or material term. */
function captionHasConcreteSignal(text: string): boolean {
  const body = normalizeDigits(String(text ?? ''));
  if (/[0-9]/.test(body) || body.includes('$') || body.includes('%') || body.includes('٪')) return true;
  return hasMaterialCryptoImpact(text);
}

/**
 * Extract currency/percent numeric cores from the caption. We only police
 * these (not every bare number) to keep false positives low. A "core" is the
 * leading integer run of the figure, e.g. "81.7" → "81", "$2" → "2".
 */
function extractGroundableFigureCores(text: string): string[] {
  const body = normalizeDigits(String(text ?? ''));
  const cores = new Set<string>();
  const patterns = [
    /\$\s*([0-9][0-9.,]*)/g,            // $2, $81.7
    /([0-9][0-9.,]*)\s*(?:%|٪|درصد)/g,  // 12%, ۱۲ درصد
    /([0-9][0-9.,]*)\s*(?:میلیون|میلیارد|تریلیون|million|billion|trillion)/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const intPart = String(m[1] ?? '').replace(/[,،]/g, '').split('.')[0];
      if (intPart && intPart.length >= 1) cores.add(intPart);
    }
  }
  return Array.from(cores);
}

function hasFullyUngroundedFigures(sourceText: unknown, caption: string): boolean {
  const cores = extractGroundableFigureCores(caption);
  if (cores.length === 0) return false; // no policed figures → nothing to ground
  const src = normalizeDigits(String(sourceText ?? '')).replace(/[,،]/g, '');
  // grounded if ANY core appears in the source digits
  const grounded = cores.some(core => src.includes(core));
  return !grounded;
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
  ]) && !hasAny(body, [
    'exploit', 'hack', 'outage', 'security incident', 'governance vote', 'mainnet upgrade',
    'regulatory', 'sec', 'cftc', 'vda', 'crypto tax', 'digital asset tax',
    'usdc', 'stablecoin', 'cross-border payouts', 'settled in usdc',
    'trading volume', 'billion', 'million',
  ]);
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
    'vda', 'crypto tax', 'digital asset tax', 'tax notice', 'tax notices', 'tds',
    'prediction market', 'prediction markets', 'trading volume',
    'usdc', 'stablecoin', 'cross-border payouts', 'settled in usdc',
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
