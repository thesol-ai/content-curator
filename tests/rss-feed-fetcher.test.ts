import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchFeed } from '../apps/worker-api/src/services/rss-feed-fetcher';

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
  <item><title>A</title><link>https://x.com/a</link></item>
</channel></rss>`;

function res(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(status === 304 ? null : body, { status, headers });
}

afterEach(() => vi.unstubAllGlobals());

describe('fetchFeed', () => {
  it('parses a healthy 200 RSS body into items with no error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200, RSS, { 'content-type': 'application/xml' })));
    const r = await fetchFeed({} as any, { feedUrl: 'https://x.com/feed', timeoutMs: 5000 });
    expect(r.status).toBe(200);
    expect(r.error).toBeNull();
    expect(r.items).toHaveLength(1);
  });

  it('flags HTTP 200 with non-XML/empty body as parse error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200, '<html><body>Page not found</body></html>', { 'content-type': 'text/html' })));
    const r = await fetchFeed({} as any, { feedUrl: 'https://x.com/feed', timeoutMs: 5000 });
    expect(r.status).toBe(200);
    expect(r.error).toBe('parse_empty_or_non_xml');
    expect(r.items).toHaveLength(0);
  });

  it('returns notModified with no error on 304', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(304, '', { etag: 'abc' })));
    const r = await fetchFeed({} as any, { feedUrl: 'https://x.com/feed', etag: 'abc', timeoutMs: 5000 });
    expect(r.notModified).toBe(true);
    expect(r.error).toBeNull();
    expect(r.items).toHaveLength(0);
  });

  it('returns an error string on HTTP 403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(403, 'Forbidden')));
    const r = await fetchFeed({} as any, { feedUrl: 'https://x.com/feed', timeoutMs: 5000 });
    expect(r.error).toBe('http_403');
    expect(r.items).toHaveLength(0);
  });
});
