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

export function formatTelegramMessage(input: TelegramMessageFormatInput): TelegramMessageFormatResult {
  const maxLength = normalizeMaxLength(input.maxLength);
  const cleanedBody = removeRawSourceReferences(String(input.body ?? ''), input.sourceUrl).trim();
  const footer = buildFooterHtml(input);
  const escapedBody = escapeHtml(cleanedBody);

  if (!footer.html) {
    return truncateHtmlText(escapedBody, maxLength, false);
  }

  const fullHtml = joinBodyAndFooter(escapedBody, footer.html);
  if (fullHtml.length <= maxLength) {
    return { html: fullHtml, truncated: false, footerIncluded: true, footerOmitted: false };
  }

  const reserved = FOOTER_SEPARATOR.length + footer.html.length;
  const remainingForBody = maxLength - reserved;

  if (remainingForBody >= 1) {
    const bodyResult = truncateEscapedText(escapedBody, remainingForBody);
    return {
      html: joinBodyAndFooter(bodyResult.html, footer.html),
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

function buildFooterHtml(input: TelegramMessageFormatInput): FooterBuildResult {
  const parts: string[] = [];

  if (isEnabled(input.channel.source_enabled)) {
    const label = sourceLabel(input.language, input.channel.source_label_override);
    const link = input.sourceUrl ? buildSourceLink(label, input.sourceUrl) : null;
    if (link) parts.push(link);
  }

  if (isEnabled(input.channel.signature_enabled)) {
    const signature = sanitizeBlockText(input.channel.signature_text, 300);
    if (signature) parts.push(escapeHtml(signature));
  }

  const footer = resolveChannelFooter(input.channel);
  if (footer) parts.push(escapeHtml(footer));

  return {
    html: parts.join('\n\n'),
    visibleParts: parts.length,
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
