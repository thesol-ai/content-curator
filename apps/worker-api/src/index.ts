// ══════════════════════════════════════════════════════════════
// index.ts — Cloudflare Worker entry point
// ══════════════════════════════════════════════════════════════

import type { Env } from './types';
import { handleHealth, handleStatus } from './routes/health';
import { handleApifyWebhook } from './routes/apify-webhook';
import { handleAdmin } from './routes/admin';
import { runCuration, publishDueItems } from './services/curation-orchestrator';
import { cleanupOldDedupeKeys } from './services/dedupe';
import { getRuntimeConfig } from './services/runtime-config';
import { maybeSendMarketSnapshotDirect } from './services/market-snapshot';
import { drainAICandidateQueue } from './services/backlog-drain';
import {
  failMaxAttemptPendingCandidates,
  isCandidateBacklogEnabled,
  recoverStaleScoringCandidates,
  skipStaleCandidates,
} from './services/candidate-queue';

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
        const runtime = await getRuntimeConfig(env);
        if (runtime.maintenanceMode) {
          console.log('[Scheduled] Skipped — maintenance_mode is active');
          return;
        }

        // 1. Scheduled curation is intentionally opt-in.
        // Webhooks should drive fresh Apify dataset ingestion; cron should not
        // repeatedly reprocess old datasets and risk unnecessary AI spend.
        if (runtime.curationEnabled && env.APIFY_SCHEDULED_CURATION_ENABLED === 'true') {
          const results = await runCuration(env);
          console.log('[Scheduled] Curation:', results.map(r => ({
            category: r.categoryId,
            ok: r.ok,
            new: r.itemsNew,
            selected: r.itemsAiSelected,
            queued: r.itemsQueued,
          })));
        }

        // 2. Enqueue hourly market snapshot, then publish due items
        try {
          const marketSnapshotResult = await maybeSendMarketSnapshotDirect(env);
          if (marketSnapshotResult.shouldRun) {
            console.log('[Scheduled] Market snapshot direct:', marketSnapshotResult);
          }
        } catch (err) {
          console.error('[Scheduled] Market snapshot direct failed:', err instanceof Error ? err.message : String(err));
        }

        const publishResult = await publishDueItems(env);
        console.log('[Scheduled] Published:', publishResult);

        // 3. Controlled AI candidate backlog drain. Runs only when explicitly enabled.
        // Publishing stays first; backlog errors are isolated so cleanup still runs.
        if (isCandidateBacklogEnabled(env)) {
          try {
            const recovered = await recoverStaleScoringCandidates(env);
            const failedMaxAttempts = await failMaxAttemptPendingCandidates(env);
            const skippedStale = await skipStaleCandidates(env);
            const drainResult = await drainAICandidateQueue(env, {
              recoverStale: false,
              skipStale: false,
            });
            console.log('[Scheduled] AI candidate backlog:', {
              recovered,
              failedMaxAttempts,
              skippedStale,
              drainResult,
            });
          } catch (err) {
            console.error('[Scheduled] AI candidate backlog failed:', err instanceof Error ? err.message : String(err));
          }
        }

        // 4. Cleanup old dedupe keys (runs every cron tick)
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
  const runtime = await getRuntimeConfig(env);
  if (runtime.maintenanceMode) {
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
