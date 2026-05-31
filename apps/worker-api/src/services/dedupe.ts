// ══════════════════════════════════════════════════════════════
// services/dedupe.ts
// جلوگیری از انتشار تکراری محتوا
// از ریپوی قدیمی: stableHash sync بهتر از crypto.subtle async است
// ══════════════════════════════════════════════════════════════

import type { Env, NormalizedItem } from '../types';

const DEDUPE_WINDOW_HOURS = 72;

// ── Sync hash (djb2 variant) — بدون نیاز به crypto.subtle ────

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

  // Key 3: text hash (برای بازنشر در پلتفرم‌های مختلف)
  if (item.text && item.text.length > 30) {
    keys.push(`txt:${stableHash(normalizeText(item.text.slice(0, 200)))}`);
  }

  // حذف duplicates
  return [...new Set(keys)];
}

// ── Check if duplicate ────────────────────────────────────────

export async function isDuplicate(env: Env, keys: string[]): Promise<boolean> {
  if (keys.length === 0) return false;

  // D1 datetime comparison — از CURRENT_TIMESTAMP و interval استفاده می‌کنیم
  const windowHours = DEDUPE_WINDOW_HOURS;

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

// ── Cleanup (در cron) ─────────────────────────────────────────

export async function cleanupOldDedupeKeys(env: Env): Promise<number> {
  const result = await env.DB
    .prepare(`DELETE FROM dedupe_keys WHERE created_at < datetime('now', '-${DEDUPE_WINDOW_HOURS} hours')`)
    .run();
  return result.meta.changes ?? 0;
}
