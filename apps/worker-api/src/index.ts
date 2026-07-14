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
import { runRssIngestion, cleanupOldRssIngestClaims } from './services/rss-ingestion';
import { buildPipelineHealthReport } from './services/pipeline-health-report'; // IMPROVEMENT #10
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
import { isCronCoordinatorEnabled, pickCoordinatorPhase, shouldRunCoordinatorHousekeeping, shouldRunHeavyPhaseAfterPublish } from './services/cron-coordinator';
import { recordRunEvent } from './services/run-events';
import { isDatasetJobProcessorEnabled, isDirectPostRotationCurationEnabled, runNextApifyDatasetJob } from './services/apify-dataset-jobs';
import { isAiBacklogStageJobsEnabled } from './services/ai-backlog-dispatcher';
import { runAiBacklogCronTick, runAiBacklogFastCronTick } from './services/ai-backlog-cron';

export default {

  // ── HTTP request handler ──────────────────────────────────
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const allowOrigin = resolveAllowedOrigin(request, env); // IMPROVEMENT #8

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': allowOrigin,
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, x-internal-api-secret, x-webhook-secret',
          'Access-Control-Max-Age': '86400',
          'Vary': 'Origin',
        },
      });
    }

    try {
      const response = await routeRequest(request, env, url, ctx);
      response.headers.set('Access-Control-Allow-Origin', allowOrigin);
      response.headers.append('Vary', 'Origin');
      return response;
    } catch (err) {
      console.error('[Worker] Unhandled error:', err);
      return Response.json(
        { ok: false, error: 'internal_server_error' },
        { status: 500, headers: { 'Access-Control-Allow-Origin': allowOrigin } }
      );
    }
  },

  // ── Cron handler ─────────────────────────────────────────
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      try {
        const scheduledTimeMs = _controller.scheduledTime ?? Date.now();
        const fastCronEnabled =
          (env as Env & {
            AI_BACKLOG_FAST_CRON_ENABLED?: string;
          }).AI_BACKLOG_FAST_CRON_ENABLED === 'true'
          && isAiBacklogStageJobsEnabled(env);
        const isFastCronTick =
          _controller.cron === '* * * * *';
        const runtime = await getRuntimeConfig(env);
        await recordFixedCryptoV2WindowTick(env, {
          scheduledTimeMs,
          maintenanceMode: runtime.maintenanceMode,
        });

        if (runtime.maintenanceMode) {
          console.log('[Scheduled] Skipped — maintenance_mode is active');
          return;
        }

        if (isFastCronTick) {
          if (!fastCronEnabled) {
            return;
          }

          const stagedResult =
            await runAiBacklogFastCronTick(
              env,
              scheduledTimeMs,
            );

          console.log(
            '[FastScheduled] AI candidate staged backlog:',
            stagedResult,
          );

          return;
        }


        if (isCronCoordinatorEnabled(env)) {
          await runRssFallbackCoordinatorTick(env, _controller.scheduledTime ?? Date.now());
          return;
        }

        let heavyPhaseConsumed = false;

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
          heavyPhaseConsumed = true;
        }

        // 1.5. Controlled Apify rotation. Disabled by default until native
        // Apify schedules are turned off, otherwise costs can double.
        if (!heavyPhaseConsumed && env.APIFY_ROTATION_ENABLED === 'true') {
          try {
            const fixedSourceId = getFixedCryptoV2ScheduleSourceId(env, scheduledTimeMs);
            let rotationResult: Awaited<ReturnType<typeof runApifyRotation>>;

            if (fixedSourceId) {
              const fixedSlot = getFixedCryptoV2RotationSlot(scheduledTimeMs);
              const claimed = await claimFixedCryptoV2RotationSlot(env, fixedSlot, fixedSourceId);
              await recordFixedCryptoV2RotationDecisionOnce(env, {
                fixedSlot,
                sourceId: fixedSourceId,
                scheduledTimeMs,
                claimed,
              });

              if (claimed) {
                rotationResult = await runApifyRotation(env, {
                  force: true,
                  onlySourceId: fixedSourceId,
                  maxSources: 1,
                });
              } else {
                await recordFixedCryptoV2RotationSkipOnce(env, {
                  fixedSlot,
                  sourceId: fixedSourceId,
                  reason: 'fixed_slot_already_claimed',
                  scheduledTimeMs,
                });

                rotationResult = {
                  ok: true,
                  skipped: true,
                  reason: 'fixed_slot_already_claimed',
                  bucket: fixedSlot,
                  rotationRunId: `apify_fixed_rotation_skip_${fixedSlot}_${Date.now()}`,
                  plans: [],
                };
              }
            } else {
              rotationResult = await runApifyRotation(env);
            }
            if (!rotationResult.skipped) {
              heavyPhaseConsumed = true;
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

              if (isDirectPostRotationCurationEnabled(env)) {
                for (const plan of rotationResult.plans) {
                  if (!plan.sourceId || !plan.defaultDatasetId || plan.error) continue;
                  try {
                    const scopedCuration = await runCuration(env, {
                      sourceId: plan.sourceId,
                      datasetId: plan.defaultDatasetId,
                    }, { forceCurationEnabled: true });
                    console.log('[Scheduled] Post-rotation curation:', {
                      sourceId: plan.sourceId,
                      datasetId: plan.defaultDatasetId,
                      runs: scopedCuration.map(r => ({
                        runId: r.runId,
                        new: r.itemsNew,
                        selected: r.itemsAiSelected,
                        queued: r.itemsQueued,
                      })),
                    });
                  } catch (err) {
                    console.error('[Scheduled] Post-rotation curation failed:', err instanceof Error ? err.message : String(err));
                  }
                }
              } else {
                console.log('[Scheduled] Direct post-rotation curation disabled; dataset jobs recorded for processor.');
              }
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

        const publishResult =
          await publishDueItems(env);

        console.log(
          '[Scheduled] Published:',
          publishResult,
        );

        if (!heavyPhaseConsumed && isDatasetJobProcessorEnabled(env)) {
          try {
            const datasetJobResult = await runNextApifyDatasetJob(env);
            if (!datasetJobResult.skipped) {
              heavyPhaseConsumed = true;
              console.log('[Scheduled] Apify dataset job processor:', datasetJobResult);
            }
          } catch (err) {
            console.error('[Scheduled] Apify dataset job processor failed:', err instanceof Error ? err.message : String(err));
          }
        }

        // 2.5. RSS feed ingestion (independent, zero-Apify-cost). After publish
        // (must not delay due posts), before backlog drain (new items get scored
        // this tick). Isolated: a slow/bad feed never affects the Apify path.
        if (!heavyPhaseConsumed && String(env.RSS_INGEST_ENABLED ?? '').toLowerCase() === 'true') {
          try {
            const rss = await runRssIngestion(env);
            if (!rss.skipped) {
              console.log('[Scheduled] RSS ingestion:', { enqueued: rss.totalEnqueued, feeds: rss.feeds });
            }
          } catch (err) {
            console.error('[Scheduled] RSS ingestion failed:', err instanceof Error ? err.message : String(err));
          }
        }

        // 3. Controlled AI candidate backlog drain. Runs only when explicitly enabled.
        // Publishing stays first; backlog errors are isolated so cleanup still runs.
        if (!fastCronEnabled && !heavyPhaseConsumed && isCandidateBacklogEnabled(env) && isAiBacklogCronDrainEnabled(env)) {
          try {
            if (
              isAiBacklogStageJobsEnabled(env)
            ) {
              const stagedResult =
                await runAiBacklogCronTick(
                  env,
                  scheduledTimeMs,
                );

              console.log(
                '[Scheduled] AI candidate staged backlog:',
                stagedResult,
              );
            } else {
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
                  String((env as any).APIFY_CRYPTO_V2_FIXED_SCHEDULE_ENABLED ?? '').toLowerCase() !== 'true' &&
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
                      queueStarving: health.state === 'starving',
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
            }
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

        // 5.1 Cleanup stale RSS ingest slot-claim keys (same settings-bloat guard)
        const rssClaimCleanup = await cleanupOldRssIngestClaims(env);
        if (rssClaimCleanup.deleted > 0) console.log(`[Scheduled] Cleaned ${rssClaimCleanup.deleted} stale RSS slot claim keys`);

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



async function recordFixedCryptoV2WindowTick(
  env: Env,
  args: {
    scheduledTimeMs: number;
    maintenanceMode: boolean;
  },
): Promise<void> {
  if (String((env as any).APIFY_CRYPTO_V2_FIXED_SCHEDULE_ENABLED ?? '').toLowerCase() !== 'true') {
    return;
  }

  if (!isFixedCryptoV2BoundaryWindow(args.scheduledTimeMs)) return;

  const fixedSlot = getFixedCryptoV2RotationSlot(args.scheduledTimeMs);
  const sourceId = getFixedCryptoV2ScheduleSourceId(env, args.scheduledTimeMs);
  const key = `scheduler_fixed_rotation_window_tick_${fixedSlot}`;

  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO settings (key, value, updated_at)
    VALUES (?, 'logged', CURRENT_TIMESTAMP)
  `).bind(key).run();

  if ((result.meta.changes ?? 0) <= 0) return;

  await recordRunEvent(env, {
    runId: `scheduler_fixed_rotation_window_${fixedSlot}_${Date.now()}`,
    eventType: 'scheduler.fixed_rotation.window_tick',
    phase: 'scheduled',
    sourceId: sourceId ?? undefined,
    metadata: {
      fixedSlot,
      slotInDay: getFixedCryptoV2SlotInDay(args.scheduledTimeMs),
      expectedSourceId: sourceId,
      scheduledTimeTehran: formatTehranTimestamp(args.scheduledTimeMs),
      maintenanceMode: args.maintenanceMode,
      cronCoordinatorEnabled: isCronCoordinatorEnabled(env),
      apifyRotationEnabled: String((env as any).APIFY_ROTATION_ENABLED ?? '').toLowerCase() === 'true',
      fixedScheduleEnabled: String((env as any).APIFY_CRYPTO_V2_FIXED_SCHEDULE_ENABLED ?? '').toLowerCase() === 'true',
      version: 'fixed_rotation_observability_v1',
    },
  });
}

function isFixedCryptoV2BoundaryWindow(scheduledTimeMs: number): boolean {
  // Tehran fixed slots start at 00:30 and repeat every 3 hours.
  // Cron runs every 5 minutes; logging the first 10 minutes is enough to prove
  // whether the Worker entered the expected rotation window.
  const tehranOffsetMs = 3.5 * 60 * 60 * 1000;
  const slotAnchorMs = 30 * 60 * 1000;
  const slotMs = 3 * 60 * 60 * 1000;
  const offset = ((scheduledTimeMs + tehranOffsetMs - slotAnchorMs) % slotMs + slotMs) % slotMs;
  return offset < 10 * 60 * 1000;
}

async function recordFixedCryptoV2RotationDecisionOnce(
  env: Env,
  args: {
    fixedSlot: number;
    sourceId: string;
    scheduledTimeMs: number;
    claimed: boolean;
  },
): Promise<void> {
  const key = `apify_rotation_slot_${args.fixedSlot}_fixed_decision_logged_${args.sourceId}`;

  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO settings (key, value, updated_at)
    VALUES (?, 'logged', CURRENT_TIMESTAMP)
  `).bind(key).run();

  if ((result.meta.changes ?? 0) <= 0) return;

  await recordRunEvent(env, {
    runId: `apify_fixed_rotation_decision_${args.fixedSlot}_${Date.now()}`,
    eventType: 'apify.fixed_rotation.decision',
    phase: 'apify_rotation',
    sourceId: args.sourceId,
    metadata: {
      fixedSlot: args.fixedSlot,
      slotInDay: getFixedCryptoV2SlotInDay(args.scheduledTimeMs),
      sourceId: args.sourceId,
      scheduledTimeTehran: formatTehranTimestamp(args.scheduledTimeMs),
      claimed: args.claimed,
      action: args.claimed ? 'run_fixed_source' : 'skip_fixed_slot_already_claimed',
      fixedScheduleEnabled: String((env as any).APIFY_CRYPTO_V2_FIXED_SCHEDULE_ENABLED ?? '').toLowerCase() === 'true',
      apifyRotationEnabled: String((env as any).APIFY_ROTATION_ENABLED ?? '').toLowerCase() === 'true',
      version: 'fixed_rotation_observability_v1',
    },
  });
}

function getFixedCryptoV2ScheduleSourceId(env: Env, scheduledTimeMs: number): string | null {
  if (String((env as any).APIFY_CRYPTO_V2_FIXED_SCHEDULE_ENABLED ?? '').toLowerCase() !== 'true') {
    return null;
  }

  const slotInDay = getFixedCryptoV2SlotInDay(scheduledTimeMs);
  const schedule = [
    'crypto_v2_analysts',
    'crypto_v2_news_a',
    'crypto_v2_news_b',
    'crypto_v2_market',
    'crypto_v2_analysts',
    'crypto_v2_news_a',
    'crypto_v2_news_b',
    'crypto_v2_market',
  ];

  return schedule[slotInDay] ?? null;
}

function getFixedCryptoV2RotationSlot(scheduledTimeMs: number): number {
  // Tehran is UTC+03:30. Fixed slots start at 00:30, then every 3 hours.
  const tehranOffsetMs = 3.5 * 60 * 60 * 1000;
  const slotAnchorMs = 30 * 60 * 1000;
  const slotMs = 3 * 60 * 60 * 1000;
  return Math.floor((scheduledTimeMs + tehranOffsetMs - slotAnchorMs) / slotMs);
}

function getFixedCryptoV2SlotInDay(scheduledTimeMs: number): number {
  const slot = getFixedCryptoV2RotationSlot(scheduledTimeMs);
  return ((slot % 8) + 8) % 8;
}

async function claimFixedCryptoV2RotationSlot(env: Env, fixedSlot: number, sourceId: string): Promise<boolean> {
  const key = `apify_rotation_slot_${fixedSlot}_fixed_${sourceId}`;
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO settings (key, value, updated_at)
    VALUES (?, 'claimed', CURRENT_TIMESTAMP)
  `).bind(key).run();

  return (result.meta.changes ?? 0) > 0;
}

async function recordFixedCryptoV2RotationSkipOnce(
  env: Env,
  args: {
    fixedSlot: number;
    sourceId: string;
    reason: string;
    scheduledTimeMs: number;
  },
): Promise<void> {
  const key = `apify_rotation_slot_${args.fixedSlot}_fixed_skip_logged_${args.sourceId}`;
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO settings (key, value, updated_at)
    VALUES (?, 'logged', CURRENT_TIMESTAMP)
  `).bind(key).run();

  if ((result.meta.changes ?? 0) <= 0) return;

  await recordRunEvent(env, {
    runId: `apify_fixed_rotation_skip_${args.fixedSlot}_${Date.now()}`,
    eventType: 'apify.rotation.skipped',
    phase: 'apify_rotation',
    sourceId: args.sourceId,
    metadata: {
      reason: args.reason,
      fixedSlot: args.fixedSlot,
      slotInDay: getFixedCryptoV2SlotInDay(args.scheduledTimeMs),
      sourceId: args.sourceId,
      scheduledTimeTehran: formatTehranTimestamp(args.scheduledTimeMs),
    },
  });
}

function formatTehranTimestamp(timestampMs: number): string {
  const tehranOffsetMs = 3.5 * 60 * 60 * 1000;
  return new Date(timestampMs + tehranOffsetMs).toISOString().replace('T', ' ').slice(0, 19);
}


function isAiBacklogCronDrainEnabled(env: Env): boolean {
  return String((env as any).AI_BACKLOG_CRON_DRAIN_ENABLED ?? 'true').toLowerCase() !== 'false';
}


async function runRssFallbackCoordinatorTick(env: Env, scheduledTimeMs: number): Promise<void> {
  const publishResult = await publishDueItems(env, { limit: 1 });
  console.log('[Scheduled] Coordinator publish:', publishResult);

  if (!shouldRunHeavyPhaseAfterPublish(publishResult)) {
    console.log('[Scheduled] Coordinator: publish active, skipping heavy phases');
    await runCoordinatorHousekeeping(env, scheduledTimeMs);
    return;
  }

  const phase = pickCoordinatorPhase(scheduledTimeMs);
  console.log(`[Scheduled] Coordinator: publish idle, phase = ${phase}`);

  if (phase === 'rss') {
    if (String(env.RSS_INGEST_ENABLED ?? '').toLowerCase() === 'true') {
      try {
        const rss = await runRssIngestion(env);
        if (!rss.skipped) {
          console.log('[Scheduled] Coordinator RSS ingestion:', { enqueued: rss.totalEnqueued, feeds: rss.feeds });
        }
      } catch (err) {
        console.error('[Scheduled] Coordinator RSS ingestion failed:', err instanceof Error ? err.message : String(err));
      }
    } else {
      console.log('[Scheduled] Coordinator RSS skipped: RSS_INGEST_ENABLED is not true');
    }

    await runCoordinatorHousekeeping(env, scheduledTimeMs);
    return;
  }

  if (phase === 'ai_drain') {
    if (isCandidateBacklogEnabled(env) && isAiBacklogCronDrainEnabled(env)) {
      try {
        if (
          isAiBacklogStageJobsEnabled(env)
        ) {
          const stagedResult =
            await runAiBacklogCronTick(
              env,
              scheduledTimeMs,
            );

          console.log(
            '[Scheduled] Coordinator AI staged backlog:',
            stagedResult,
          );
        } else {
        const recovered = await recoverStaleScoringCandidates(env);
        const failedMaxAttempts = await failMaxAttemptPendingCandidates(env);
        const skippedStale = await skipStaleCandidates(env);
        const drainResult = await drainAICandidateQueue(env, {
          recoverStale: false,
          skipStale: false,
          maxBatches: 1,
        });

        console.log('[Scheduled] Coordinator AI candidate backlog:', {
          recovered,
          failedMaxAttempts,
          skippedStale,
          drainResult,
        });
        }
      } catch (err) {
        console.error('[Scheduled] Coordinator AI candidate backlog failed:', err instanceof Error ? err.message : String(err));
      }
    } else {
      console.log('[Scheduled] Coordinator AI skipped: AI_CANDIDATE_BACKLOG_ENABLED is not true');
    }

    await runCoordinatorHousekeeping(env, scheduledTimeMs);
    return;
  }

  await runCoordinatorHousekeeping(env, scheduledTimeMs);
}

async function runCoordinatorHousekeeping(env: Env, scheduledTimeMs: number): Promise<void> {
  if (!shouldRunCoordinatorHousekeeping(scheduledTimeMs)) return;

  const cleaned = await cleanupOldDedupeKeys(env);
  if (cleaned > 0) console.log(`[Scheduled] Coordinator cleaned ${cleaned} old dedupe keys`);

  const rotationCleanup = await cleanupOldRotationClaims(env);
  if (rotationCleanup.deleted > 0) console.log(`[Scheduled] Coordinator cleaned ${rotationCleanup.deleted} stale rotation claim keys`);

  const rssClaimCleanup = await cleanupOldRssIngestClaims(env);
  if (rssClaimCleanup.deleted > 0) console.log(`[Scheduled] Coordinator cleaned ${rssClaimCleanup.deleted} stale RSS slot claim keys`);

  await cleanupAiUsageAttribution(env);
  await cleanupStoryIntelligenceEvents(env);
}


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

  const runtime = await getRuntimeConfig(env);

  // Internal admin endpoints — require x-internal-api-secret header.
  // During maintenance, allow only a tiny authenticated control-plane subset so
  // operators can recover ingestion without waking scheduled cron/backlog drain.
  if (path.startsWith('/internal/')) {
    const secret = request.headers.get('x-internal-api-secret');
    if (!verifySecret(secret, env)) {
      return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    const maintenanceAllowedInternalPaths = new Set([
      '/internal/admin/toggle',
      '/internal/admin/settings',
      '/internal/curation/trigger',
    ]);

    if (runtime.maintenanceMode && !maintenanceAllowedInternalPaths.has(path)) {
      return Response.json(
        { ok: false, error: 'maintenance_mode', message: 'System is in maintenance mode' },
        { status: 503 }
      );
    }

    // IMPROVEMENT #10: read-only pipeline health report (behind internal auth).
    if (path === '/internal/pipeline-health') {
      const hours = Number(url.searchParams.get('hours') ?? '6');
      const category = url.searchParams.get('category') ?? undefined; // v4: optional scoping
      const report = await buildPipelineHealthReport(env, Number.isFinite(hours) && hours > 0 ? hours : 6, category);
      return Response.json(report);
    }
    return handleAdmin(request, env, ctx);
  }

  // Maintenance mode check — blocks all non-health, non-approved-internal routes.
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

  return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
}

// ── Auth ──────────────────────────────────────────────────────

function verifySecret(provided: string | null, env: Env): boolean {
  const expected = env.INTERNAL_API_SECRET?.trim();
  if (!expected) return env.ENVIRONMENT === 'local';
  return provided === expected;
}

// IMPROVEMENT #8: CORS origin allowlist.
// CORS_ALLOWED_ORIGINS is a comma-separated list (e.g. "https://admin.example.com").
// When unset, we keep the previous permissive '*' behaviour for backward
// compatibility (admin/webhook routes are already secret-protected, so this is
// not a security hole — it just tightens browser-side access when configured).
function resolveAllowedOrigin(request: Request, env: Env): string {
  const raw = String((env as any).CORS_ALLOWED_ORIGINS ?? '').trim();
  if (!raw) return '*';
  const allow = raw.split(',').map(s => s.trim()).filter(Boolean);
  const origin = request.headers.get('Origin') ?? '';
  return allow.includes(origin) ? origin : (allow[0] ?? '*');
}
