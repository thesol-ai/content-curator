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
import { cleanupOldRotationClaims, getDiversityRotationSourceId, getRotationSlotMinutes, getStarvationRotationSourceId, runApifyRotation } from './services/apify-rotation-runner';
import { handleTelegramAdminBot } from './routes/telegram-admin-bot';
import {
  failMaxAttemptPendingCandidates,
  getMaxScoringBatchesPerRun,
  isCandidateBacklogEnabled,
  recoverStaleScoringCandidates,
  skipStaleCandidates,
} from './services/candidate-queue';
import {
  decideDrainBatches,
  getQueueHealth,
  getStarvingMaxBatches,
  getStarvingScoringCallBonus,
  isQueueHealthControllerEnabled,
  shouldTriggerEarlyRotation,
} from './services/queue-health';
import {
  buildQueueQualityReport,
  cleanupAiUsageAttribution,
  decideQualitySteer,
  getQualitySteerConfig,
  isQueueQualityControllerEnabled,
} from './services/observability-reports';
import { cleanupStoryIntelligenceEvents } from './services/story-intelligence';

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

        // 1.5. Controlled Apify rotation. Disabled by default until native
        // Apify schedules are turned off, otherwise costs can double.
        if (env.APIFY_ROTATION_ENABLED === 'true') {
          try {
            const rotationResult = await runApifyRotation(env);
            if (!rotationResult.skipped) {
              console.log('[Scheduled] Apify rotation:', {
                ok: rotationResult.ok,
                bucket: rotationResult.bucket,
                plans: rotationResult.plans.map(plan => ({
                  sourceId: plan.sourceId,
                  status: plan.status,
                  dataset: plan.defaultDatasetId,
                  cohort: plan.cohortName,
                })),
              });
            }
          } catch (err) {
            console.error('[Scheduled] Apify rotation failed:', err instanceof Error ? err.message : String(err));
          }
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

            // Phase 6F: queue-health controller. Only adapts the *rate* of
            // scoring and (optionally) triggers a single early source rotation
            // when the near-term queue is starving. It never relaxes any
            // quality gate. Fully inert unless QUEUE_HEALTH_CONTROLLER_ENABLED.
            let drainMaxBatches: number | undefined;
            let drainScoringBonus: number | undefined;
            if (isQueueHealthControllerEnabled(env)) {
              try {
                const channelId =
                  (env as any).QUEUE_HEALTH_CHANNEL_ID?.trim() ||
                  (env as any).MARKET_SNAPSHOT_CHANNEL_ID?.trim() ||
                  'crypto_fa_pilot';
                const health = await getQueueHealth(env, channelId);
                drainMaxBatches = decideDrainBatches(
                  health.state,
                  getMaxScoringBatchesPerRun(env),
                  getStarvingMaxBatches(env, getMaxScoringBatchesPerRun(env)),
                );
                if (health.state === 'starving') drainScoringBonus = getStarvingScoringCallBonus(env);

                // Phase-next (gated, default off): even if the COUNT is healthy,
                // steer rotation toward more diverse sources when the upcoming
                // queue is concentrated. Steering only — never rejects.
                let qualitySteer = false;
                let qualityTopSource: string | null = null;
                let qualityTopSourceId: string | null = null;
                if (isQueueQualityControllerEnabled(env)) {
                  try {
                    const qq = await buildQueueQualityReport(env, channelId);
                    qualitySteer = decideQualitySteer(qq, getQualitySteerConfig(env));
                    qualityTopSource = qq.topSourceNext24h;
                    qualityTopSourceId = qq.topSourceIdNext24h;
                  } catch (err) {
                    console.warn('[Scheduled] Queue-quality steer skipped:', err instanceof Error ? err.message : String(err));
                  }
                }
                console.log('[Scheduled] Queue-health:', {
                  channelId,
                  state: health.state,
                  next6h: health.scheduledNext6h,
                  backloaded: health.backloaded,
                  pending: health.pendingCandidates,
                  drainMaxBatches,
                  drainScoringBonus,
                });

                // Starvation rotation: scrape exactly ONE source — the one
                // designated for the current slot (rotates over time) rather
                // than always the alphabetically-first source. Only when the
                // last rotation is not very recent (avoid double-firing a slot).
                if (
                  env.APIFY_ROTATION_ENABLED === 'true' &&
                  (shouldTriggerEarlyRotation(health) || qualitySteer) &&
                  (health.rotationAgeMin == null || health.rotationAgeMin >= getRotationSlotMinutes(env))
                ) {
                  try {
                    const sourceId = (qualitySteer && !shouldTriggerEarlyRotation(health))
                      ? await getDiversityRotationSourceId(env, { avoidAccount: qualityTopSource, avoidSourceId: qualityTopSourceId })
                      : await getStarvationRotationSourceId(env);
                    const r = await runApifyRotation(env, {
                      force: true,
                      maxSources: 1,
                      ...(sourceId ? { onlySourceId: sourceId } : {}),
                    });
                    console.log('[Scheduled] Adaptive rotation:', { ok: r.ok, skipped: r.skipped, fired: r.plans.length, sourceId, reason: qualitySteer ? 'quality_steer' : 'starvation' });
                  } catch (err) {
                    console.error('[Scheduled] Adaptive rotation failed:', err instanceof Error ? err.message : String(err));
                  }
                }
              } catch (err) {
                console.error('[Scheduled] Queue-health controller failed:', err instanceof Error ? err.message : String(err));
              }
            }

            const drainResult = await drainAICandidateQueue(env, {
              recoverStale: false,
              skipStale: false,
              ...(drainMaxBatches != null ? { maxBatches: drainMaxBatches } : {}),
              ...(drainScoringBonus != null ? { scoringCallBonus: drainScoringBonus } : {}),
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

        // 5. Cleanup stale Apify rotation claim keys (prevents settings bloat)
        const rotationCleanup = await cleanupOldRotationClaims(env);
        if (rotationCleanup.deleted > 0) console.log(`[Scheduled] Cleaned ${rotationCleanup.deleted} stale rotation claim keys`);

        // 6. Retention cleanup for ai_usage_attribution (daily-guarded; no-op unless
        //    cost attribution is enabled). Prevents the attribution table from growing forever.
        await cleanupAiUsageAttribution(env);

        // 7. Retention cleanup for story_intelligence_events (daily-guarded; no-op unless
        //    story intelligence is enabled). The dedupe window is ~48h, so old rows are dead weight.
        await cleanupStoryIntelligenceEvents(env);

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

  // Telegram admin bot webhook — public URL, protected by Telegram secret header and allowed user ids
  if (path === '/telegram/admin/webhook') {
    return handleTelegramAdminBot(request, env);
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
