// ══════════════════════════════════════════════════════════════
// index.ts — Cloudflare Worker entry point
// ══════════════════════════════════════════════════════════════

import type { Env } from './types';
import { handleHealth, handleStatus } from './routes/health';
import { handleApifyWebhook } from './routes/apify-webhook';
import { handleAdmin } from './routes/admin';
import { runCuration, publishDueItems } from './services/curation-orchestrator';
import { cleanupOldDedupeKeys } from './services/dedupe';

export default {

  // ── HTTP request handler ──────────────────────────────────
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, x-internal-api-secret, x-webhook-secret',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    try {
      const response = await routeRequest(request, env, url, ctx);
      response.headers.set('Access-Control-Allow-Origin', '*');
      return response;
    } catch (err) {
      console.error('[Worker] Unhandled error:', err);
      return Response.json(
        { ok: false, error: 'internal_server_error' },
        { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } }
      );
    }
  },

  // ── Cron handler ─────────────────────────────────────────
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      try {
        // Check maintenance_mode before running cron tasks
        const maintenance = await getSettingDirect(env, 'maintenance_mode');
        if (maintenance === 'true') {
          console.log('[Scheduled] Skipped — maintenance_mode is active');
          return;
        }

        // 1. Curation
        if (env.APIFY_CURATION_ENABLED === 'true') {
          const results = await runCuration(env);
          console.log('[Scheduled] Curation:', results.map(r => ({
            category: r.categoryId,
            ok: r.ok,
            new: r.itemsNew,
            selected: r.itemsAiSelected,
            queued: r.itemsQueued,
          })));
        }

        // 2. Publish due items
        const publishResult = await publishDueItems(env);
        console.log('[Scheduled] Published:', publishResult);

        // 3. Cleanup old dedupe keys (runs every cron tick)
        const cleaned = await cleanupOldDedupeKeys(env);
        if (cleaned > 0) console.log(`[Scheduled] Cleaned ${cleaned} old dedupe keys`);

      } catch (err) {
        console.error('[Scheduled] Error:', err instanceof Error ? err.message : String(err));
      }
    })());
  },
} satisfies ExportedHandler<Env>;

// ── Route dispatcher ──────────────────────────────────────────

async function routeRequest(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext
): Promise<Response> {
  const path = url.pathname;

  // Public endpoints — always available
  if (path === '/health' || path === '/') {
    return handleHealth(request, env);
  }
  if (path === '/status') {
    return handleStatus(request, env);
  }

  // Maintenance mode check — blocks all non-health routes
  const maintenance = await getSettingDirect(env, 'maintenance_mode');
  if (maintenance === 'true') {
    return Response.json(
      { ok: false, error: 'maintenance_mode', message: 'System is in maintenance mode' },
      { status: 503 }
    );
  }

  // Apify webhook — accepts secret from header OR query param (header preferred)
  if (path === '/webhook/apify') {
    const secret =
      request.headers.get('x-webhook-secret') ??
      request.headers.get('x-internal-api-secret') ??
      url.searchParams.get('secret');
    if (!verifySecret(secret, env)) {
      return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }
    return handleApifyWebhook(request, env, ctx);
  }

  // Internal admin endpoints — require x-internal-api-secret header
  if (path.startsWith('/internal/')) {
    const secret = request.headers.get('x-internal-api-secret');
    if (!verifySecret(secret, env)) {
      return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }
    return handleAdmin(request, env, ctx);
  }

  return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
}

// ── Auth ──────────────────────────────────────────────────────

function verifySecret(provided: string | null, env: Env): boolean {
  const expected = env.INTERNAL_API_SECRET?.trim();
  if (!expected) return env.ENVIRONMENT === 'local';
  return provided === expected;
}

// ── Settings helper (used before full DB service loads) ───────

async function getSettingDirect(env: Env, key: string): Promise<string> {
  try {
    const row = await env.DB
      .prepare('SELECT value FROM settings WHERE key = ?')
      .bind(key).first<{ value: string }>();
    return row?.value ?? '';
  } catch { return ''; }
}
