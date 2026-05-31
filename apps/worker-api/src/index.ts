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
          'Access-Control-Allow-Headers': 'Content-Type, x-internal-api-secret',
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
        // ۱. Curation
        if (env.APIFY_CURATION_ENABLED === 'true') {
          const results = await runCuration(env);
          console.log('[Scheduled] Curation:', results.map(r => ({
            category: r.categoryId,
            ok: r.ok,
            queued: r.itemsQueued,
          })));
        }

        // ۲. Publish due items
        const publishResult = await publishDueItems(env);
        console.log('[Scheduled] Published:', publishResult);

        // ۳. Cleanup dedupe keys قدیمی (هر بار cron)
        const cleaned = await cleanupOldDedupeKeys(env);
        if (cleaned > 0) console.log(`[Scheduled] Cleaned ${cleaned} old dedupe keys`);

      } catch (err) {
        console.error('[Scheduled] Error:', err);
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

  // ── Public ──
  if (path === '/health' || path === '/') {
    return handleHealth(request, env);
  }

  if (path === '/status') {
    return handleStatus(request, env);
  }

  // ── Apify webhook — secret در query param یا header ──
  if (path === '/webhook/apify') {
    const secret = url.searchParams.get('secret') ?? request.headers.get('x-internal-api-secret');
    if (!verifySecret(secret, env)) {
      return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }
    // با waitUntil: سریع acknowledge کن، پردازش async ادامه یابد
    const responsePromise = handleApifyWebhook(request, env, ctx);
    return responsePromise;
  }

  // ── Internal — نیاز به secret ──
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
  if (!expected) {
    return env.ENVIRONMENT === 'local';
  }
  return provided === expected;
}
