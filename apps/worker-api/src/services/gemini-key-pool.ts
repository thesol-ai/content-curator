import type { Env } from '../types';

export interface GeminiKeyRef {
  name: string;
  key: string;
}

const DEFAULT_GEMINI_KEY_NAME = 'GEMINI_API_KEY';

export function getGeminiKeyPool(env: Env): GeminiKeyRef[] {
  const rawPool = String((env as any).GEMINI_API_KEY_POOL ?? '').trim();
  const names = rawPool
    ? rawPool.split(',').map(name => name.trim()).filter(Boolean)
    : [DEFAULT_GEMINI_KEY_NAME];

  const seen = new Set<string>();
  const pool: GeminiKeyRef[] = [];

  for (const name of names) {
    if (!/^[A-Z0-9_]{3,80}$/.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);

    const key = String((env as any)[name] ?? '').trim();
    if (key) pool.push({ name, key });
  }

  // Backward-compatible fallback if a pool was configured badly but the legacy
  // secret exists. This keeps deploys safe while secrets are being added.
  if (pool.length === 0 && rawPool) {
    const key = String((env as any)[DEFAULT_GEMINI_KEY_NAME] ?? '').trim();
    if (key) pool.push({ name: DEFAULT_GEMINI_KEY_NAME, key });
  }

  return pool;
}

export function shouldTryNextGeminiKey(status: number, errorText: string): boolean {
  const text = String(errorText ?? '').toLowerCase();

  if (status === 401 || status === 429) return true;

  if (status === 403) {
    return /quota|rate|limit|billing|billable|exceeded|exhausted|insufficient|resource|permission|api key|key/.test(text);
  }

  if (status >= 500 && status <= 599) return true;

  return /quota|rate|limit|billing|exceeded|exhausted|insufficient balance|resource exhausted|api key not valid|expired|incorrect/.test(text);
}
