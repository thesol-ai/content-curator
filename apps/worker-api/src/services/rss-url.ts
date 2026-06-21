// ── RSS URL canonicalization ──────────────────────────────────
//
// RSS items arrive with tracking-decorated, sometimes mobile/amp, links. The
// candidate queue has a UNIQUE index on source_url (idx_ai_candidate_queue_
// source_url_unique), and RSS dedup keys both source_url and post_id off the
// article URL — so the canonical form must be stable across the variants a feed
// (or its syndication) can emit for the same article.

const TRACKING_PARAM_PREFIXES = ['utm_'];
const TRACKING_PARAM_EXACT = new Set([
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid',
  'mc_cid', 'mc_eid', 'igshid', 'ref', 'ref_src', 'ref_url',
  'cmpid', 'campaign', 'source', 'spm', 'yclid', '_hsenc', '_hsmi',
]);

function isTrackingParam(key: string): boolean {
  const k = key.toLowerCase();
  if (TRACKING_PARAM_EXACT.has(k)) return true;
  return TRACKING_PARAM_PREFIXES.some(p => k.startsWith(p));
}

function stripAmpMobileHost(host: string): string {
  // amp.example.com → example.com ; m.example.com → example.com ;
  // www.example.com → example.com (treat www as non-distinguishing)
  return host
    .replace(/^amp\./, '')
    .replace(/^m\./, '')
    .replace(/^mobile\./, '')
    .replace(/^www\./, '');
}

/**
 * Canonicalize an article URL so the same article maps to one stable key.
 * Returns the input trimmed if it cannot be parsed as an absolute URL.
 */
export function canonicalArticleUrl(raw: unknown): string {
  const input = String(raw ?? '').trim();
  if (!input) return '';

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input;
  }

  // http → https; lowercase host; strip amp/mobile/www
  if (url.protocol === 'http:') url.protocol = 'https:';
  url.hostname = stripAmpMobileHost(url.hostname.toLowerCase());

  // Drop fragment.
  url.hash = '';

  // Drop tracking query params; keep meaningful ones, sorted for stability.
  const kept: Array<[string, string]> = [];
  for (const [k, v] of url.searchParams.entries()) {
    if (!isTrackingParam(k)) kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  url.search = '';
  for (const [k, v] of kept) url.searchParams.append(k, v);

  // Normalize path: drop trailing slash (but keep root "/").
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '');
  url.pathname = path;

  let out = url.toString();
  // URL keeps a trailing "?" off, but guard anyway.
  out = out.replace(/\?$/, '');
  return out;
}
