// ══════════════════════════════════════════════════════════════
// services/telegram-message-formatter.ts
// Builds Telegram-safe HTML for post bodies, source links, signatures,
// and channel footers. This module owns the final HTML it returns.
// ══════════════════════════════════════════════════════════════

import type { ChannelRow } from '../types';

export interface TelegramMessageFormatInput {
  body: string;
  sourceUrl?: string;
  language: string;
  channel: ChannelRow;
  maxLength: number;
}

export interface TelegramMessageFormatResult {
  html: string;
  truncated: boolean;
  footerIncluded: boolean;
  footerOmitted: boolean;
}

interface FooterBuildResult {
  html: string;
  visibleParts: number;
}

const DEFAULT_SOURCE_LABELS: Record<string, string> = {
  fa: 'منبع',
  en: 'Source',
};

const ELLIPSIS = '…';
const FOOTER_SEPARATOR = '\n\n';
const TITLE_SEPARATOR_RE = /^([^\n]{12,180})\n+\s*([\s\S]{20,})$/u;

// Telegram clients can visually reorder decimal/percent numbers inside Persian RTL text.
// Example: "۲.۵ درصد" may be rendered as "۵.۲" on some clients.
// Keep only the numeric expression LTR-isolated, instead of forcing the whole message RTL.
const LTR_ISOLATE = '\u2066';
const POP_DIRECTIONAL_ISOLATE = '\u2069';

const RTL_NUMERIC_RUN_RE = /(?:[$€£]\s*)?[+\-−]?[0-9۰-۹٠-٩]+(?:[0-9۰-۹٠-٩.,٫٬\s]*[0-9۰-۹٠-٩])?(?:\s*(?:%|٪|bps|bp|BTC|ETH|USDT|USDC|USD|EUR|GBP|BNB|SOL|XRP|ADA|DOGE|TON|TRX|AVAX|LINK|DOT|MATIC|POL|ARB|OP|LTC|BCH|UNI|AAVE|SUI|APT|SEI|INJ|NEAR|ATOM|FIL|million|billion|trillion|m|b|k))?/giu;

const RTL_NUMERIC_FOLLOW_RE = /^\s*(?:درصد|دلار|یورو|پوند|میلیون|میلیارد|تریلیون|واحد|توکن|کوین|بیت‌کوین|اتریوم|BTC|ETH|USDT|USDC|USD)/iu;

export function stabilizeRtlNumbersForTelegram(text: string, language: string): string {
  const lang = String(language ?? '').trim().toLowerCase();
  const raw = String(text ?? '');
  if (lang !== 'fa' && lang !== 'ar') return raw;

  return raw.replace(RTL_NUMERIC_RUN_RE, (match: string, offset: number, full: string) => {
    const value = String(match ?? '');
    if (!value.trim()) return value;

    const before = full.slice(Math.max(0, offset - 1), offset);
    const after = full.slice(offset + value.length, offset + value.length + 1);
    if (before === LTR_ISOLATE && after === POP_DIRECTIONAL_ISOLATE) return value;

    const following = full.slice(offset + value.length, offset + value.length + 24);
    const hasDecimalOrSymbol = /[.,٫٬%٪$€£]/u.test(value);
    const hasLatinUnit = /(?:BTC|ETH|USDT|USDC|USD|EUR|GBP|BNB|SOL|XRP|ADA|DOGE|TON|TRX|AVAX|LINK|DOT|MATIC|POL|ARB|OP|LTC|BCH|UNI|AAVE|SUI|APT|SEI|INJ|NEAR|ATOM|FIL|million|billion|trillion|bps|bp)\b/iu.test(value);
    const hasRtlUnitAfter = RTL_NUMERIC_FOLLOW_RE.test(following);

    if (!hasDecimalOrSymbol && !hasLatinUnit && !hasRtlUnitAfter) return value;
    return `${LTR_ISOLATE}${value}${POP_DIRECTIONAL_ISOLATE}`;
  });
}

export function formatTelegramMessage(input: TelegramMessageFormatInput): TelegramMessageFormatResult {
  const maxLength = normalizeMaxLength(input.maxLength);
  const rawCleanedBody = removeVisibleHashtagLines(removeRawSourceReferences(String(input.body ?? ''), input.sourceUrl)).trim();
  const cleanedBody = stabilizeRtlNumbersForTelegram(rawCleanedBody, input.language);
  const footer = buildFooterHtml(input);
  // Do not inject Unicode direction marks.
  // Telegram boxes, numeric tables, tickers, links, and @handles can break badly when the whole message is forced RTL.
  // Persian captions should instead start with natural Persian wording at generation time.
  const escapedBody = formatBodyWithBoldLeadTitle(cleanedBody, input.language);
  const footerHtml = footer.html;

  if (!footerHtml) {
    return truncateHtmlText(escapedBody, maxLength, false);
  }

  const fullHtml = joinBodyAndFooter(escapedBody, footerHtml);
  if (fullHtml.length <= maxLength) {
    return { html: fullHtml, truncated: false, footerIncluded: true, footerOmitted: false };
  }

  const reserved = FOOTER_SEPARATOR.length + footerHtml.length;
  const remainingForBody = maxLength - reserved;

  if (remainingForBody >= 1) {
    const bodyResult = truncateEscapedText(escapedBody, remainingForBody);
    return {
      html: joinBodyAndFooter(bodyResult.html, footerHtml),
      truncated: bodyResult.truncated,
      footerIncluded: true,
      footerOmitted: false,
    };
  }

  // Footer is atomic. If it cannot fit with at least one body character,
  // omit it instead of splitting source/signature/footer in half.
  const bodyOnly = truncateHtmlText(escapedBody, maxLength, true);
  return { ...bodyOnly, footerIncluded: false, footerOmitted: footer.visibleParts > 0 };
}

export function escapeHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatBodyWithBoldLeadTitle(text: string, language: string): string {
  const raw = String(text ?? '').trim();
  const lang = String(language ?? '').trim().toLowerCase();

  // RSS Persian briefs are generated as:
  // title
  //
  // body
  //
  // When that structure is present, render the first line as a real Telegram HTML
  // title. Do this in the formatter, not in model output, because this module owns
  // Telegram-safe HTML escaping.
  if (lang === 'fa' || lang === 'ar') {
    const m = raw.match(TITLE_SEPARATOR_RE);
    if (m) {
      const title = ensureTitleEndsWithPeriod(m[1]!.trim());
      const body = m[2]!.trim();
      return `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(body)}`;
    }
  }

  return escapeHtml(raw);
}

function ensureTitleEndsWithPeriod(title: string): string {
  const cleaned = String(title ?? '').trim().replace(/[.。؟?!،؛:]+$/u, '').trim();
  return cleaned ? `${cleaned}.` : cleaned;
}


export function escapeHtmlAttr(text: string): string {
  return escapeHtml(text)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sourceLabel(language: string, override?: string | null): string {
  const custom = sanitizeSingleLine(override, 32);
  if (custom) return custom;
  return DEFAULT_SOURCE_LABELS[String(language ?? '').toLowerCase()] ?? DEFAULT_SOURCE_LABELS.en!;
}

export function buildSourceLink(label: string, url: string): string | null {
  const safeUrl = safeHttpUrl(url);
  if (!safeUrl) return null;
  return `<a href="${escapeHtmlAttr(safeUrl)}">${escapeHtml(label)}</a>`;
}


export function buildSourceBlock(label: string, url: string): string | null {
  const normalized = sanitizeSingleLine(label, 32) ?? sourceLabel('en');

  if (normalized.startsWith('🌏 ')) {
    const linkText = normalized.slice('🌏 '.length).trim();
    const link = buildSourceLink(linkText || 'Source', url);
    return link ? `🌏 ${link}` : null;
  }

  return buildSourceLink(normalized, url);
}

export function resolveChannelFooter(channel: ChannelRow): string | null {
  if (!isEnabled(channel.channel_id_footer_enabled)) return null;
  const custom = sanitizeSingleLine(channel.channel_id_footer_text, 80);
  if (custom) return custom;

  const chatId = String(channel.telegram_chat_id ?? '').trim();
  return chatId.startsWith('@') ? chatId.slice(0, 80) : null;
}

export function removeRawSourceReferences(body: string, sourceUrl?: string): string {
  const rawBody = String(body ?? '');
  const variants = sourceUrlVariants(sourceUrl);
  if (variants.length === 0) return rawBody;

  let result = rawBody;
  for (const variant of variants) {
    const urlPattern = escapeRegExp(variant);
    const sourceLinePattern = new RegExp(
      `(^|\\n)\\s*(?:source|منبع|لینک|link)?\\s*[:：-]?\\s*${urlPattern}\\s*(?=\\n|$)`,
      'giu'
    );
    result = result.replace(sourceLinePattern, '$1');
    result = result.replace(new RegExp(urlPattern, 'gu'), '');
  }

  return result
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


export function removeVisibleHashtagLines(body: string): string {
  return String(body ?? '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      return !/^(#[\p{L}\p{N}_\u200c-]+[\s\u200c]*)+$/u.test(trimmed);
    })
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildFooterHtml(input: TelegramMessageFormatInput): FooterBuildResult {
  const blocks: string[] = [];

  const sourceParts: string[] = [];
  if (isEnabled(input.channel.source_enabled)) {
    const label = sourceLabel(input.language, input.channel.source_label_override);
    const link = input.sourceUrl ? buildSourceBlock(label, input.sourceUrl) : null;
    if (link) sourceParts.push(link);
  }

  const signatureParts: string[] = [];
  if (isEnabled(input.channel.signature_enabled)) {
    const signature = sanitizeBlockText(input.channel.signature_text, 300);
    if (signature) signatureParts.push(escapeHtml(signature));
  }

  const footer = resolveChannelFooter(input.channel);
  if (footer) signatureParts.push(escapeHtml(footer));

  const sourceBlock = sourceParts.join(String.fromCharCode(10));
  const signatureBlock = signatureParts.join(String.fromCharCode(10));

  // Keep the footer compact inside Telegram cards:
  // body
  //
  // Source
  // @channel
  //
  // Previously Source and @channel were separate blocks, which rendered an
  // awkward blank line between them in the final post footer.
  if (sourceBlock && signatureBlock) {
    blocks.push([sourceBlock, signatureBlock].join(String.fromCharCode(10)));
  } else if (sourceBlock) {
    blocks.push(sourceBlock);
  } else if (signatureBlock) {
    blocks.push(signatureBlock);
  }

  return {
    html: blocks.join(String.fromCharCode(10, 10)),
    visibleParts: blocks.length,
  };
}


function truncateHtmlText(escapedBody: string, maxLength: number, footerOmitted: boolean): TelegramMessageFormatResult {
  const bodyResult = truncateEscapedText(escapedBody, maxLength);
  return {
    html: bodyResult.html,
    truncated: bodyResult.truncated,
    footerIncluded: false,
    footerOmitted,
  };
}

function truncateEscapedText(escapedText: string, maxLength: number): { html: string; truncated: boolean } {
  if (escapedText.length <= maxLength) return { html: escapedText, truncated: false };
  if (maxLength <= 0) return { html: '', truncated: escapedText.length > 0 };
  if (maxLength === 1) return { html: ELLIPSIS, truncated: true };

  const cutLength = maxLength - ELLIPSIS.length;
  const safeCut = safeEntityBoundary(escapedText, cutLength);
  return {
    html: escapedText.slice(0, safeCut).replace(/[ \t\n]+$/g, '') + ELLIPSIS,
    truncated: true,
  };
}

function safeEntityBoundary(value: string, proposed: number): number {
  const bounded = Math.max(0, Math.min(value.length, proposed));
  const lastAmp = value.lastIndexOf('&', bounded - 1);
  if (lastAmp === -1) return bounded;

  const lastSemi = value.lastIndexOf(';', bounded - 1);
  if (lastSemi > lastAmp) return bounded;

  const fragment = value.slice(lastAmp, bounded);
  if (/^&(amp|lt|gt|quot|#39?)?$/i.test(fragment) || /^&#\d{0,5}$/i.test(fragment)) {
    return lastAmp;
  }
  return bounded;
}

function joinBodyAndFooter(bodyHtml: string, footerHtml: string): string {
  const body = String(bodyHtml ?? '').trim();
  const footer = String(footerHtml ?? '').trim();
  if (!body) return footer;
  if (!footer) return body;
  return `${body}${FOOTER_SEPARATOR}${footer}`;
}

function normalizeMaxLength(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 4096;
  return Math.max(0, Math.floor(n));
}

function isEnabled(value: unknown): boolean {
  if (value === false || value === 0 || value === '0') return false;
  if (typeof value === 'string' && value.toLowerCase() === 'false') return false;
  return true;
}

function sanitizeSingleLine(input: string | null | undefined, maxLength: number): string | null {
  const value = String(input ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return value ? value.slice(0, maxLength) : null;
}

function sanitizeBlockText(input: string | null | undefined, maxLength: number): string | null {
  const value = String(input ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return value ? value.slice(0, maxLength) : null;
}

function safeHttpUrl(raw: string): string | null {
  try {
    const url = new URL(String(raw ?? '').trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function sourceUrlVariants(sourceUrl?: string): string[] {
  const raw = String(sourceUrl ?? '').trim();
  if (!raw) return [];

  const variants = new Set<string>([raw, raw.replace(/\/$/, ''), raw.replace(/\/$/, '') + '/']);
  try {
    const url = new URL(raw);
    url.hash = '';
    const normalized = url.toString();
    variants.add(normalized);
    variants.add(normalized.replace(/\/$/, ''));
    variants.add(normalized.replace(/\/$/, '') + '/');
    variants.add(normalized.replace(/^https:\/\//, 'http://'));
    variants.add(normalized.replace(/^http:\/\//, 'https://'));
  } catch {
    // Keep raw variants only.
  }

  return Array.from(variants).filter(Boolean).sort((a, b) => b.length - a.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
