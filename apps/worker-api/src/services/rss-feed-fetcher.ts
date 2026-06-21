// ── RSS feed fetch (direct HTTP, conditional GET) ─────────────
//
// Direct fetch (zero Apify cost). Sends a browser UA + Accept header (feeds 403
// a bare client) and conditional headers (ETag / Last-Modified) so unchanged
// feeds return 304 and cost nothing to parse.

import type { Env } from '../types';
import { parseRssFeed, type RawRssItem } from './rss-feed-parser';

const UA = 'Mozilla/5.0 (compatible; ContentCuratorBot/1.0; +https://heli.technology/bot)';
const ACCEPT = 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8';

export interface FeedFetchInput {
  feedUrl: string;
  etag?: string | null;
  lastModified?: string | null;
  timeoutMs: number;
}

export interface FeedFetchResult {
  status: number;
  notModified: boolean;
  items: RawRssItem[];
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
  error: string | null;
}

export async function fetchFeed(_env: Env, input: FeedFetchInput): Promise<FeedFetchResult> {
  const headers: Record<string, string> = { 'User-Agent': UA, 'Accept': ACCEPT };
  if (input.etag) headers['If-None-Match'] = input.etag;
  if (input.lastModified) headers['If-Modified-Since'] = input.lastModified;

  try {
    const res = await fetch(input.feedUrl, {
      headers,
      signal: AbortSignal.timeout(input.timeoutMs),
    });

    const etag = res.headers.get('etag');
    const lastModified = res.headers.get('last-modified');
    const contentType = res.headers.get('content-type');

    if (res.status === 304) {
      return { status: 304, notModified: true, items: [], etag, lastModified, contentType, error: null };
    }
    if (!res.ok) {
      return { status: res.status, notModified: false, items: [], etag, lastModified, contentType, error: `http_${res.status}` };
    }

    const xml = await res.text();
    const items = parseRssFeed(xml);
    return { status: res.status, notModified: false, items, etag, lastModified, contentType, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 0, notModified: false, items: [], etag: null, lastModified: null, contentType: null, error: msg.slice(0, 200) };
  }
}
