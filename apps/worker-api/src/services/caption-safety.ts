import type { TranslationOutput } from '../types';

export interface CaptionSafetyOptions {
  riskFlags?: string[];
  shortMaxChars?: number;
  fullMaxChars?: number;
}

export interface CaptionSafetyResult {
  ok: boolean;
  translation?: TranslationOutput;
  reason?: string;
}

const TRAILING_CONNECTOR_RE =
  /(?:^|\s)(?:اگر|که|برای|با|از|در|به|و|یا|اما|ولی|تا|بر|روی|ضمن|پس از|پیش از)$/u;

function normalizeDigits(value: unknown): string {
  const fa = '۰۱۲۳۴۵۶۷۸۹';
  const ar = '٠١٢٣٤٥٦٧٨٩';

  return String(value ?? '').replace(/[۰-۹٠-٩]/g, char => {
    const faIndex = fa.indexOf(char);
    if (faIndex >= 0) return String(faIndex);

    const arIndex = ar.indexOf(char);
    if (arIndex >= 0) return String(arIndex);

    return char;
  });
}

function normalizeText(value: unknown): string {
  return normalizeDigits(value)
    .toLowerCase()
    .replace(/[\u200c\u200d]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalNumber(value: string): string {
  let result = normalizeDigits(value)
    .replace(/[٬،,_\s]/g, '')
    .replace(/٫/g, '.')
    .trim();

  if (result.includes('.')) {
    result = result
      .replace(/0+$/g, '')
      .replace(/\.$/g, '');
  }

  result = result.replace(/^0+(?=\d)/g, '');

  return result || '0';
}

/**
 * Extract every explicit numeric value, not only currency/percentage values.
 *
 * Examples:
 * 4,201 -> 4201
 * ۸۶.۸ -> 86.8
 * 99.90 -> 99.9
 * V4 -> 4
 */
export function extractCanonicalNumbers(value: unknown): string[] {
  const text = normalizeDigits(value).replace(/٫/g, '.');

  const matches =
    text.match(/[0-9][0-9,٬،_]*(?:\.[0-9]+)?/g) ?? [];

  return Array.from(
    new Set(
      matches
        .map(canonicalNumber)
        .filter(Boolean),
    ),
  );
}

export function findUnsupportedNumbers(
  sourceText: unknown,
  caption: unknown,
): string[] {
  const sourceNumbers = new Set(extractCanonicalNumbers(sourceText));
  const captionNumbers = extractCanonicalNumbers(caption);

  return captionNumbers.filter(number => !sourceNumbers.has(number));
}

function stripLeadingDecoration(value: string): string {
  return value
    .replace(
      /^[\s\p{Extended_Pictographic}\uFE0F\u200C\u200D"'“”‘’«»()[\]{}<>.,:;،؛.!?؟\-–—_+*=|\\/@#$]+/u,
      '',
    )
    .trim();
}

export function captionTitle(value: unknown): string {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .find(Boolean) ?? '';
}

function normalizedTitle(value: unknown): string {
  return normalizeText(stripLeadingDecoration(captionTitle(value)));
}

export function captionsUseSameTitle(
  shortCaption: unknown,
  fullCaption: unknown,
): boolean {
  const shortTitle = normalizedTitle(shortCaption);
  const fullTitle = normalizedTitle(fullCaption);

  return Boolean(shortTitle && fullTitle && shortTitle === fullTitle);
}

function splitCaption(value: unknown): {
  title: string;
  body: string;
} {
  const text = String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  if (!text) {
    return { title: '', body: '' };
  }

  const blankLine = text.match(/\n\s*\n/u);

  if (blankLine && blankLine.index !== undefined) {
    const titleBlock = text.slice(0, blankLine.index).trim();
    const body = text
      .slice(blankLine.index + blankLine[0].length)
      .trim();

    const title =
      titleBlock
        .split(/\n+/u)
        .map(line => line.trim())
        .find(Boolean) ?? '';

    return { title, body };
  }

  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  return {
    title: lines.shift() ?? '',
    body: lines.join(' ').trim(),
  };
}

function truncateAtWordBoundary(
  value: string,
  maxChars: number,
): string {
  const text = value.trim();

  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return '';

  const candidate = text.slice(0, maxChars).trim();
  const lastSpace = candidate.lastIndexOf(' ');

  if (lastSpace > Math.floor(maxChars * 0.55)) {
    return candidate.slice(0, lastSpace).trim();
  }

  return candidate;
}

/**
 * Truncates only at a sentence boundary.
 *
 * If no complete body sentence fits, it returns the title rather than publishing
 * a broken clause. A shorter post is less damaging than "Moonbeam نیز برنامه".
 */
export function truncateCaptionAtBoundary(
  value: unknown,
  maxChars: number,
): string {
  const text = String(value ?? '')
    .replace(/\r\n/g, '\n')
    .trim();

  if (!text || !Number.isFinite(maxChars) || maxChars <= 0) {
    return '';
  }

  if (text.length <= maxChars) {
    return text;
  }

  const { title, body } = splitCaption(text);

  if (!title) {
    return truncateAtWordBoundary(text, maxChars);
  }

  const safeTitle = truncateAtWordBoundary(title, maxChars);

  if (!body || safeTitle.length >= maxChars) {
    return safeTitle;
  }

  const bodyBudget = maxChars - safeTitle.length - 2;

  if (bodyBudget <= 0) {
    return safeTitle;
  }

  const sentences =
    body.match(/[^.!?؟。]+[.!?؟。]+/gu) ?? [];

  const accepted: string[] = [];

  for (const sentence of sentences) {
    const clean = sentence.trim();
    if (!clean) continue;

    const nextBody = [...accepted, clean].join(' ');

    if (nextBody.length > bodyBudget) {
      break;
    }

    accepted.push(clean);
  }

  if (accepted.length === 0) {
    return safeTitle;
  }

  return `${safeTitle}\n\n${accepted.join(' ')}`;
}

function requiresExplicitAttribution(
  riskFlags: string[] | undefined,
): boolean {
  const flags = (riskFlags ?? [])
    .join(' ')
    .toLowerCase();

  return /(?:unverified|allegation|opinion|prediction|forecast|forward[_ -]?looking|speculation|rumou?r|price[_ -]?prediction|market[_ -]?prediction)/u.test(
    flags,
  );
}

function hasExplicitAttributionCue(title: string): boolean {
  const normalized = normalizeText(title);

  return (
    /(?:به گفته|به‌گفته|طبق|بر اساس|براساس|گزارش|اعلام کرد|اعلام کرده|ادعا|مدعی|می گوید|می‌گوید|گفت|پیش بینی|پیش‌بینی|به باور|از نظر|به اعتقاد|برآورد|احتمال|ممکن است|می تواند|می‌تواند)/u.test(
      normalized,
    ) ||
    normalized.includes(':')
  );
}

function hasSuspiciousTrailingConnector(value: unknown): boolean {
  const normalized = normalizeText(value);
  return Boolean(normalized && TRAILING_CONNECTOR_RE.test(normalized));
}

export function validateAndCompactCaption(
  sourceText: unknown,
  translation: TranslationOutput,
  options: CaptionSafetyOptions = {},
): CaptionSafetyResult {
  const compacted: TranslationOutput = {
    ...translation,
    captionShort: truncateCaptionAtBoundary(
      translation.captionShort,
      options.shortMaxChars ?? Number.MAX_SAFE_INTEGER,
    ),
    captionFull: truncateCaptionAtBoundary(
      translation.captionFull,
      options.fullMaxChars ?? Number.MAX_SAFE_INTEGER,
    ),
    hashtags: translation.hashtags,
  };

  const shortTitle = captionTitle(compacted.captionShort);
  const fullTitle = captionTitle(compacted.captionFull);

  if (!shortTitle || !fullTitle) {
    return {
      ok: false,
      reason: 'caption_title_missing',
    };
  }

  if (!captionsUseSameTitle(
    compacted.captionShort,
    compacted.captionFull,
  )) {
    return {
      ok: false,
      reason: 'caption_title_mismatch',
    };
  }

  const combinedCaption =
    `${compacted.captionShort}\n${compacted.captionFull}`;

  // Numeric wording can change naturally during translation.
  // Do not reject an otherwise valid caption solely because its numeric
  // representation differs from the source.

  if (
    requiresExplicitAttribution(options.riskFlags) &&
    !hasExplicitAttributionCue(shortTitle)
  ) {
    return {
      ok: false,
      reason: 'caption_missing_required_attribution',
    };
  }

  if (
    hasSuspiciousTrailingConnector(compacted.captionShort) ||
    hasSuspiciousTrailingConnector(compacted.captionFull)
  ) {
    return {
      ok: false,
      reason: 'caption_incomplete_sentence',
    };
  }

  return {
    ok: true,
    translation: compacted,
  };
}
