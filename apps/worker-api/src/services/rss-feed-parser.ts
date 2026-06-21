// ── RSS feed parsing (fast-xml-parser) ────────────────────────
//
// RSS is XML: CDATA, namespaces (content:, media:, dc:), entities, and optional
// fields. We use fast-xml-parser rather than regex so these are handled
// correctly. parseRssFeed never throws — invalid XML yields [].

import { XMLParser } from 'fast-xml-parser';

export interface RawRssItem {
  title: string;
  link: string;
  guid: string | null;
  pubDate: string | null;
  description: string;
  contentEncoded: string;
  author: string | null;
  imageCandidates: string[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,   // keep values as strings (guid "1" stays "1")
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
});

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Pull a plain string out of a node that may be a string, {#text}, or array. */
function text(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return text(node[0]);
  if (typeof node === 'object') {
    const t = (node as Record<string, unknown>)['#text'];
    if (t != null) return text(t);
  }
  return '';
}

function attr(node: unknown, name: string): string | null {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    const v = (node as Record<string, unknown>)[`@_${name}`];
    if (v != null) return String(v);
  }
  return null;
}

function looksLikeImage(url: string | null, type?: string | null, medium?: string | null): boolean {
  if (!url) return false;
  if (!/^https:\/\//i.test(url)) return false;
  if (medium && medium.toLowerCase() === 'image') return true;
  if (type && /^image\//i.test(type)) return true;
  return /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url);
}

function firstHtmlImage(html: string): string | null {
  const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  const url = m?.[1] ?? null;
  return url && /^https:\/\//i.test(url) ? url : null;
}

function collectImages(item: Record<string, unknown>, contentEncoded: string, description: string): string[] {
  const out: string[] = [];
  const push = (u: string | null) => { if (u && !out.includes(u)) out.push(u); };

  // media:content (may repeat)
  for (const mc of asArray(item['media:content'])) {
    const url = attr(mc, 'url');
    if (looksLikeImage(url, attr(mc, 'type'), attr(mc, 'medium'))) push(url);
  }
  // media:thumbnail
  for (const mt of asArray(item['media:thumbnail'])) {
    const url = attr(mt, 'url');
    if (url && /^https:\/\//i.test(url)) push(url);
  }
  // enclosure
  for (const en of asArray(item['enclosure'])) {
    const url = attr(en, 'url');
    if (looksLikeImage(url, attr(en, 'type'), null)) push(url);
  }
  // first <img> inside content / description
  push(firstHtmlImage(contentEncoded));
  push(firstHtmlImage(description));

  return out;
}

/** Parse an RSS 2.0 document into raw items. Never throws. */
export function parseRssFeed(xml: string): RawRssItem[] {
  let doc: any;
  try {
    doc = parser.parse(String(xml ?? ''));
  } catch {
    return [];
  }
  if (!doc || typeof doc !== 'object') return [];

  const items = asArray(doc?.rss?.channel?.item);
  if (items.length === 0) return [];

  const out: RawRssItem[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;

    const contentEncoded = text(item['content:encoded']);
    const description = text(item['description']);
    const guidRaw = text(item['guid']).trim();

    out.push({
      title: text(item['title']).trim(),
      link: text(item['link']).trim(),
      guid: guidRaw || null,
      pubDate: (text(item['pubDate']) || text(item['dc:date']) || '').trim() || null,
      description,
      contentEncoded,
      author: (text(item['dc:creator']) || text(item['author']) || '').trim() || null,
      imageCandidates: collectImages(item, contentEncoded, description),
    });
  }
  return out;
}
