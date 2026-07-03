// ══════════════════════════════════════════════════════════════
// services/dedupe.ts
// Deduplication — configurable window, three key types
//
// Fix 10.1: DEDUPE_WINDOW_HOURS is now configurable (was hardcoded 72h)
//   Default: 168h (7 days) — better for evergreen/viral content
//   Set via wrangler.toml: DEDUPE_WINDOW_HOURS = "168"
// ══════════════════════════════════════════════════════════════

import type { Env, NormalizedItem } from '../types';

const DEFAULT_DEDUPE_WINDOW_HOURS = 168; // 7 days

function getDedupeWindowHours(env?: Env): number {
  if (!env) return DEFAULT_DEDUPE_WINDOW_HOURS;
  const parsed = parseInt(env.DEDUPE_WINDOW_HOURS || String(DEFAULT_DEDUPE_WINDOW_HOURS), 10);
  return isNaN(parsed) || parsed <= 0 ? DEFAULT_DEDUPE_WINDOW_HOURS : parsed;
}

// ── Sync hash (djb2 variant) ──────────────────────────────────

function stableHash(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === 'https:' && u.port === '443') ||
        (u.protocol === 'http:'  && u.port === '80')) {
      u.port = '';
    }
    if (u.pathname.length > 1) {
      u.pathname = u.pathname.replace(/\/+$/, '');
    }
    // Remove common tracking params
    ['utm_source','utm_medium','utm_campaign','utm_term','utm_content',
     'fbclid','gclid','ref','source'].forEach(p => u.searchParams.delete(p));
    u.searchParams.sort();
    return u.toString();
  } catch {
    return url.toLowerCase().trim();
  }
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

// ── Compute dedupe keys ───────────────────────────────────────

export function computeDedupeKeys(item: NormalizedItem): string[] {
  const keys: string[] = [];

  // Key 1: platform + post_id
  if (item.postId && item.postId.length > 3) {
    keys.push(`pid:${item.platform}:${item.postId}`);
  }

  // Key 2: normalized URL hash
  if (item.sourceUrl) {
    keys.push(`url:${stableHash(normalizeUrl(item.sourceUrl))}`);
  }

  // Key 3: text hash — uses longer slice (200→300) for better cross-platform detection
  if (item.text && item.text.length > 30) {
    keys.push(`txt:${stableHash(normalizeText(item.text.slice(0, 300)))}`);
  }

  return [...new Set(keys)];
}

// ── Check if duplicate ────────────────────────────────────────

export async function isDuplicate(env: Env, keys: string[]): Promise<boolean> {
  if (keys.length === 0) return false;

  const windowHours = getDedupeWindowHours(env);

  for (const key of keys) {
    const row = await env.DB
      .prepare(`
        SELECT 1 FROM dedupe_keys
        WHERE key = ?
          AND created_at > datetime('now', '-${windowHours} hours')
        LIMIT 1
      `)
      .bind(key)
      .first();
    if (row) return true;
  }
  return false;
}

// ── Record keys ───────────────────────────────────────────────

export async function findExistingDedupeKeys(env: Env, keys: string[]): Promise<Set<string>> {
  const uniqueKeys = [...new Set(
    keys
      .map(key => String(key ?? '').trim())
      .filter(Boolean)
  )];

  const found = new Set<string>();
  if (uniqueKeys.length === 0) return found;

  const windowHours = getDedupeWindowHours(env);
  const chunkSize = 80;

  for (let i = 0; i < uniqueKeys.length; i += chunkSize) {
    const chunk = uniqueKeys.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');

    const rows = await env.DB
      .prepare(`
        SELECT key
        FROM dedupe_keys
        WHERE key IN (${placeholders})
          AND created_at > datetime('now', '-${windowHours} hours')
      `)
      .bind(...chunk)
      .all<{ key: string }>();

    for (const row of rows.results ?? []) {
      if (typeof row.key === 'string') found.add(row.key);
    }
  }

  return found;
}

export async function recordDedupeKeys(
  env: Env,
  keys: string[],
  itemId: string
): Promise<void> {
  for (const key of keys) {
    await env.DB
      .prepare('INSERT OR IGNORE INTO dedupe_keys (key, item_id, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
      .bind(key, itemId)
      .run();
  }
}

// ── Cleanup (called from cron) ────────────────────────────────

export async function cleanupOldDedupeKeys(env: Env): Promise<number> {
  const windowHours = getDedupeWindowHours(env);
  const result = await env.DB
    .prepare(`DELETE FROM dedupe_keys WHERE created_at < datetime('now', '-${windowHours} hours')`)
    .run();
  return result.meta.changes ?? 0;
}
