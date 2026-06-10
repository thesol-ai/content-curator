// ══════════════════════════════════════════════════════════════
// services/curation-orchestrator.ts — v3
// هماهنگ‌کننده اصلی pipeline
// ══════════════════════════════════════════════════════════════

import type { Env, CategoryRow, ChannelRow, ApifySourceRow, NormalizedItem, PublishedMediaResult, AIGateResult } from '../types';
import { fetchApifyDataset, normalizeItem } from './apify-client';
import { computeDedupeKeys, isDuplicate, recordDedupeKeys } from './dedupe';
import { runAIGate } from './ai-gate';
import { checkChannelPublishWindowAt, runRuleGate } from './rule-gate';
import { resolveMedia, extractMediaTypes } from './media-resolver';
import { publishToTelegram } from './telegram-publisher';
import { getRuntimeConfig, withEffectiveCurationEnv, type RuntimeConfigOverrides } from './runtime-config';
import { recordRunEvent, recordRunItemEvent } from './run-events';
import { buildPolicyRejectAiResult, findSimilarTopicInRunRejections, getItemRejectReason, getPreAiContentRejectReason } from './content-policy';
import { drainAICandidateQueue } from './backlog-drain';
import { enqueueCandidates, isCandidateBacklogEnabled, updateCandidatesStatus } from './candidate-queue';
export { findSimilarTopicInRunRejections, getItemRejectReason, getPreAiContentRejectReason } from './content-policy';

export interface CurationRunResult {
  runId: string;
  categoryId: string;
  platform: string;
  ok: boolean;
  itemsFetched: number;
  itemsNew: number;
  itemsDuplicate: number;
  itemsAiSelected: number;
  itemsAiRejected: number;
  itemsQueued: number;
  dryRun: boolean;
  errors: string[];
  durationMs: number;
}

// ── Entry point ───────────────────────────────────────────────

export interface CurationSourceScope {
  datasetId?: string;
  sourceId?: string;
}

export async function runCuration(
  env: Env,
  scopeOrDatasetId?: string | CurationSourceScope,
  overrides: RuntimeConfigOverrides = {}
): Promise<CurationRunResult[]> {
  const runtime = await getRuntimeConfig(env, overrides);
  if (!runtime.curationEnabled) return [];

  const effectiveEnv = withEffectiveCurationEnv(env, runtime);
  const scope = normalizeCurationScope(scopeOrDatasetId);

  let sources = await loadApifySources(effectiveEnv);
  if (sources.length === 0) { console.log('[Curation] No Apify sources configured'); return []; }

  sources = await scopeApifySources(effectiveEnv, sources, scope);
  if (sources.length === 0) return [];

  const byCategory = new Map<string, ApifySourceRow[]>();
  for (const src of sources) {
    const list = byCategory.get(src.category_id) ?? [];
    list.push(src);
    byCategory.set(src.category_id, list);
  }

  const results: CurationRunResult[] = [];
  for (const [categoryId, categorySources] of byCategory) {
    const category = await loadCategory(effectiveEnv, categoryId);
    if (!category) { console.warn(`[Curation] Category not found: ${categoryId}`); continue; }
    for (const source of categorySources) {
      results.push(await processSingleSource(effectiveEnv, category, source));
    }
  }
  return results;
}


function normalizeCurationScope(input?: string | CurationSourceScope): CurationSourceScope {
  if (!input) return {};
  if (typeof input === 'string') return { datasetId: input };
  return {
    datasetId: sanitizeApifyDatasetId(input.datasetId) ?? undefined,
    sourceId: sanitizeSourceId(input.sourceId) ?? undefined,
  };
}

async function scopeApifySources(
  env: Env,
  sources: ApifySourceRow[],
  scope: CurationSourceScope,
): Promise<ApifySourceRow[]> {
  const datasetId = sanitizeApifyDatasetId(scope.datasetId);
  const sourceId = sanitizeSourceId(scope.sourceId);

  if (sourceId) {
    const scoped = sources.filter(s => s.id === sourceId);
    if (scoped.length === 0) {
      console.warn(`[Curation] Webhook source_id=${sourceId} did not match any enabled Apify source — skipped`);
      return [];
    }

    if (datasetId) {
      await updateApifySourceLastDataset(env, sourceId, datasetId);
      console.log(`[Curation] Webhook source_id=${sourceId} dataset=${datasetId} → 1 source`);
      return scoped.map(s => ({ ...s, apify_dataset_id: datasetId, last_dataset_id: datasetId }));
    }

    console.log(`[Curation] Scoped curation source_id=${sourceId} → 1 source`);
    return scoped;
  }

  if (datasetId) {
    const scoped = sources
      .filter(s => s.apify_dataset_id === datasetId || s.last_dataset_id === datasetId)
      .map(s => ({ ...s, apify_dataset_id: datasetId, last_dataset_id: datasetId }));

    if (scoped.length === 0) {
      console.warn(`[Curation] Webhook dataset=${datasetId} did not match any enabled Apify source — skipped`);
      return [];
    }

    for (const src of scoped) await updateApifySourceLastDataset(env, src.id, datasetId);
    console.log(`[Curation] Webhook dataset=${datasetId} → ${scoped.length} source(s)`);
    return scoped;
  }

  return sources;
}

function sanitizeApifyDatasetId(value: unknown): string | null {
  const v = String(value ?? '').trim();
  return /^[A-Za-z0-9]{8,40}$/.test(v) ? v : null;
}

function sanitizeSourceId(value: unknown): string | null {
  const v = String(value ?? '').trim();
  return /^[\w-]{1,64}$/.test(v) ? v : null;
}

async function updateApifySourceLastDataset(env: Env, sourceId: string, datasetId: string): Promise<void> {
  await env.DB
    .prepare('UPDATE apify_sources SET apify_dataset_id=?, last_dataset_id=? WHERE id=?')
    .bind(datasetId, datasetId, sourceId)
    .run();
}

function isPlaceholderDatasetId(value: unknown): boolean {
  return String(value ?? '').trim().startsWith('placeholder_');
}

function resolveInitialDatasetId(source: ApifySourceRow): string {
  const primary = String(source.apify_dataset_id ?? '').trim();
  const last = String(source.last_dataset_id ?? '').trim();

  if (sanitizeApifyDatasetId(last) && last !== primary) {
    return last;
  }

  return primary;
}

function datasetSyncReason(primaryDatasetId: string, effectiveDatasetId: string): string | null {
  if (!effectiveDatasetId || effectiveDatasetId === primaryDatasetId) return null;

  return isPlaceholderDatasetId(primaryDatasetId)
    ? 'placeholder_primary_resolved_from_last_dataset_id'
    : 'stale_primary_resolved_from_last_dataset_id';
}

function getApifyRawFetchLimit(env: Env, finalLimit: number): number {
  const explicit = Number((env as any).APIFY_RAW_FETCH_LIMIT_PER_SOURCE);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(finalLimit, Math.min(Math.floor(explicit), 1000));
  }

  const multiplier = Number((env as any).APIFY_RAW_FETCH_MULTIPLIER ?? 5);
  const safeMultiplier = Number.isFinite(multiplier) && multiplier > 0
    ? Math.min(Math.floor(multiplier), 10)
    : 5;

  return Math.max(finalLimit, Math.min(finalLimit * safeMultiplier, 500));
}

function balanceNormalizedItemsBySourceAccount(items: NormalizedItem[]): NormalizedItem[] {
  if (items.length <= 1) return items.slice();

  const groups = new Map<string, NormalizedItem[]>();
  const accountOrder: string[] = [];

  for (const item of items) {
    const account = normalizedSourceAccountKey(item);
    if (!groups.has(account)) {
      groups.set(account, []);
      accountOrder.push(account);
    }
    groups.get(account)!.push(item);
  }

  if (accountOrder.length <= 1) return items.slice();

  const balanced: NormalizedItem[] = [];
  let madeProgress = true;

  while (balanced.length < items.length && madeProgress) {
    madeProgress = false;
    for (const account of accountOrder) {
      const next = groups.get(account)!.shift();
      if (next) {
        balanced.push(next);
        madeProgress = true;
      }
    }
  }

  return balanced;
}

function normalizedSourceAccountKey(item: NormalizedItem): string {
  const account = String(item.sourceAccount ?? '').trim().toLowerCase();
  return account || '__unknown__';
}

function summarizeSourceAccounts(items: NormalizedItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = normalizedSourceAccountKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function fetchSourceDatasetItems(
  env: Env,
  source: ApifySourceRow,
  datasetId: string,
  maxItems: number,
  runId: string,
  category: CategoryRow,
  startedAtMs: number
): Promise<{ raw: any[]; datasetId: string; usedFallback: boolean }> {
  try {
    const raw = await fetchApifyDataset(datasetId, env.APIFY_TOKEN, maxItems);
    return { raw, datasetId, usedFallback: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const lastDatasetId = sanitizeApifyDatasetId(source.last_dataset_id);

    if (
      lastDatasetId &&
      lastDatasetId !== datasetId &&
      (message.includes('404') || message.toLowerCase().includes('not found'))
    ) {
      await recordRunEvent(env, {
        runId,
        eventType: 'dataset.fetch.fallback',
        phase: 'fetch_dataset',
        categoryId: category.id,
        platform: source.platform,
        sourceId: source.id,
        datasetId,
        durationMs: Date.now() - startedAtMs,
        metadata: {
          failedDatasetId: datasetId,
          fallbackDatasetId: lastDatasetId,
          reason: message.slice(0, 300),
        },
      });

      const raw = await fetchApifyDataset(lastDatasetId, env.APIFY_TOKEN, maxItems);

      await updateApifySourceLastDataset(env, source.id, lastDatasetId);

      return { raw, datasetId: lastDatasetId, usedFallback: true };
    }

    throw err;
  }
}

// ── Process one source ────────────────────────────────────────

async function processSingleSource(
  env: Env, category: CategoryRow, source: ApifySourceRow
): Promise<CurationRunResult> {
  const t0 = Date.now();
  const dryRun = env.APIFY_CURATION_DRY_RUN === 'true';
  const maxItems = Math.max(1, parseInt(env.APIFY_MAX_ITEMS_PER_SOURCE || '100', 10));
  const rawFetchLimit = getApifyRawFetchLimit(env, maxItems);
  const runId = generateId('run');
  const errors: string[] = [];
  let phase = 'init';
  let itemsFetched = 0, itemsNew = 0, itemsDuplicate = 0;
  let itemsAiSelected = 0, itemsAiRejected = 0, itemsQueued = 0;
  let effectiveDatasetId = resolveInitialDatasetId(source);
  const primaryDatasetId = String(source.apify_dataset_id ?? '').trim();

  const syncReason = datasetSyncReason(primaryDatasetId, effectiveDatasetId);

  if (syncReason) {
    await updateApifySourceLastDataset(env, source.id, effectiveDatasetId);
    await recordRunEvent(env, {
      runId,
      eventType: 'dataset.primary.synced',
      phase: 'init',
      categoryId: category.id,
      platform: source.platform,
      sourceId: source.id,
      datasetId: effectiveDatasetId,
      durationMs: Date.now() - t0,
      metadata: {
        previousDatasetId: primaryDatasetId,
        syncedDatasetId: effectiveDatasetId,
        reason: syncReason,
      },
    });
  }

  const markPhase = async (nextPhase: string): Promise<void> => {
    phase = nextPhase;
    console.log(`[Curation][${category.id}/${source.platform}] run=${runId} dataset=${effectiveDatasetId} phase=${phase}`);
    try {
      await finishRun(env, runId, category.id, source.platform, effectiveDatasetId, 'processing', {
        itemsFetched,
        itemsNew,
        itemsDuplicate,
        itemsAiSelected,
        itemsAiRejected,
        itemsQueued,
        errorMessage: `processing phase=${phase}`,
        durationMs: Date.now() - t0,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Curation][${category.id}/${source.platform}] failed to persist phase ${phase}: ${msg}`);
    }

    await recordRunEvent(env, {
      runId,
      eventType: 'phase.changed',
      phase,
      categoryId: category.id,
      platform: source.platform,
      sourceId: source.id,
      datasetId: effectiveDatasetId,
      durationMs: Date.now() - t0,
      metadata: {
        itemsFetched,
        itemsNew,
        itemsDuplicate,
        itemsAiSelected,
        itemsAiRejected,
        itemsQueued,
      },
    });
  };

  await saveDiscoveryRun(env, runId, category.id, source.platform, effectiveDatasetId, 'processing');
  await recordRunEvent(env, {
    runId,
    eventType: 'curation.run.created',
    phase: 'init',
    categoryId: category.id,
    platform: source.platform,
    sourceId: source.id,
    datasetId: effectiveDatasetId,
    metadata: {
      dryRun,
      maxItems,
      aiMaxCandidatesPerRun: env.AI_MAX_CANDIDATES_PER_RUN,
      apifyMaxItemsPerSource: env.APIFY_MAX_ITEMS_PER_SOURCE,
      translationBatchSize: (env as any).TRANSLATION_BATCH_SIZE,
    },
  });

  try {
    await markPhase('fetch_dataset');
    const fetched = await fetchSourceDatasetItems(env, source, effectiveDatasetId, rawFetchLimit, runId, category, t0);
    const raw = fetched.raw;
    effectiveDatasetId = fetched.datasetId;
    itemsFetched = raw.length;

    await recordRunEvent(env, {
      runId,
      eventType: 'dataset.fetch.success',
      phase,
      categoryId: category.id,
      platform: source.platform,
      sourceId: source.id,
      datasetId: effectiveDatasetId,
      durationMs: Date.now() - t0,
      metadata: {
        rawCount: raw.length,
        maxItems,
        usedFallback: fetched.usedFallback,
      },
    });

    await markPhase('normalize_items');
    const normalized: NormalizedItem[] = [];
    let droppedNormalizeNull = 0;
    let droppedMissingUrl = 0;
    let droppedShortTextNoSignal = 0;
    let keptShortTextWithSignal = 0;

    for (const r of raw) {
      const item = normalizeItem(r, source.platform as any);

      if (!item) {
        droppedNormalizeNull++;
        continue;
      }

      if (!item.sourceUrl) {
        droppedMissingUrl++;
        continue;
      }

      const hasSignal =
        item.media.length > 0 ||
        Number(item.engagementLikes ?? 0) >= 100 ||
        Number(item.engagementShares ?? 0) >= 20 ||
        Number(item.engagementViews ?? 0) >= 10000;

      if (item.text.length < 15 && !hasSignal) {
        droppedShortTextNoSignal++;
        continue;
      }

      if (item.text.length < 15 && hasSignal) {
        keptShortTextWithSignal++;
      }

      normalized.push(item);
    }

    const normalizedBeforeBalance = normalized.length;
    const normalizedBalanced = balanceNormalizedItemsBySourceAccount(normalized).slice(0, maxItems);

    await recordRunEvent(env, {
      runId,
      eventType: 'normalize.complete',
      phase: 'normalize_items',
      categoryId: category.id,
      platform: source.platform,
      sourceId: source.id,
      datasetId: effectiveDatasetId,
      durationMs: Date.now() - t0,
      metadata: {
        rawCount: raw.length,
        rawFetchLimit,
        maxItems,
        normalizedBeforeBalance,
        normalizedCount: normalizedBalanced.length,
        sourceAccountsBeforeBalance: summarizeSourceAccounts(normalized),
        sourceAccountsAfterBalance: summarizeSourceAccounts(normalizedBalanced),
        droppedNormalizeNull,
        droppedMissingUrl,
        droppedShortTextNoSignal,
        keptShortTextWithSignal,
      },
    });

    await markPhase('dedupe_check');
    const fresh: NormalizedItem[] = [];
    const freshKeys: string[][] = [];
    for (const item of normalizedBalanced) {
      const keys = computeDedupeKeys(item);
      if (await isDuplicate(env, keys)) { itemsDuplicate++; }
      else { fresh.push(item); freshKeys.push(keys); }
    }
    itemsNew = fresh.length;
    await recordRunEvent(env, {
      runId,
      eventType: 'dedupe.complete',
      phase: 'dedupe_check',
      categoryId: category.id,
      platform: source.platform,
      sourceId: source.id,
      datasetId: effectiveDatasetId,
      durationMs: Date.now() - t0,
      metadata: {
        normalizedCount: normalized.length,
        freshCount: fresh.length,
        duplicateCount: itemsDuplicate,
      },
    });
    await markPhase('dedupe_complete');

    if (fresh.length === 0) {
      await finishRun(env, runId, category.id, source.platform, effectiveDatasetId,
        dryRun ? 'dry_run' : 'completed', { itemsFetched, itemsNew, itemsDuplicate, durationMs: Date.now() - t0 });
      return mkResult(runId, category.id, source.platform, true, dryRun,
        { itemsFetched, itemsNew, itemsDuplicate, durationMs: Date.now() - t0 });
    }

    if (isCandidateBacklogEnabled(env)) {
      await markPhase('enqueue_ai_candidates');
      const enqueueResults = await enqueueCandidates(env, fresh.map((item, i) => ({
        sourceId: source.id,
        runId,
        categoryId: category.id,
        platform: item.platform,
        sourceAccount: item.sourceAccount,
        sourceUrl: item.sourceUrl,
        postId: item.postId,
        publishedAt: item.publishedAt,
        normalizedItem: item,
        dedupeKeys: freshKeys[i] ?? [],
        priorityScore: computeCandidatePriorityScore(item),
      })));

      const insertedIds = enqueueResults.filter(r => r.inserted).map(r => r.id);
      const enqueueErrors = enqueueResults.filter(r => typeof r.reason === 'string' && r.reason.startsWith('error:'));
      await recordRunEvent(env, {
        runId,
        eventType: 'candidate.enqueue.completed',
        phase: 'enqueue_ai_candidates',
        categoryId: category.id,
        platform: source.platform,
        sourceId: source.id,
        datasetId: effectiveDatasetId,
        durationMs: Date.now() - t0,
        metadata: {
          freshCount: fresh.length,
          inserted: insertedIds.length,
          duplicateOrExisting: enqueueResults.filter(r => !r.inserted && r.reason === 'duplicate_source_url').length,
          errors: enqueueErrors.length,
        },
      });

      if (enqueueErrors.length > 0) {
        if (insertedIds.length > 0) {
          await updateCandidatesStatus(env, insertedIds, 'failed', { lastError: 'enqueue_partial_failure_fallback_to_legacy' });
        }
        await recordRunEvent(env, {
          runId,
          eventType: 'candidate.enqueue.fallback_to_legacy',
          phase: 'enqueue_ai_candidates',
          severity: 'warn',
          message: 'AI candidate backlog enqueue failed; falling back to legacy inline scoring for this run.',
          categoryId: category.id,
          platform: source.platform,
          sourceId: source.id,
          datasetId: effectiveDatasetId,
          durationMs: Date.now() - t0,
          metadata: { errors: enqueueErrors.map(e => e.reason).slice(0, 10) },
        });
      } else {
        await markPhase('drain_ai_candidate_backlog');
        const drain = await drainAICandidateQueue(env, { categoryId: category.id });
        itemsAiSelected += drain.candidatesSelected;
        itemsAiRejected += drain.candidatesRejected + drain.candidatesFailed + drain.candidatesSkipped;
        itemsQueued += drain.candidatesQueued;

        await finishRun(env, runId, category.id, source.platform, effectiveDatasetId,
          dryRun ? 'dry_run' : 'completed', { itemsFetched, itemsNew, itemsDuplicate, itemsAiSelected, itemsAiRejected, itemsQueued, durationMs: Date.now() - t0 });
        await recordRunEvent(env, {
          runId,
          eventType: dryRun ? 'run.dry_run_completed' : 'run.completed',
          phase: 'finalize',
          categoryId: category.id,
          platform: source.platform,
          sourceId: source.id,
          datasetId: effectiveDatasetId,
          durationMs: Date.now() - t0,
          metadata: {
            itemsFetched,
            itemsNew,
            itemsDuplicate,
            itemsAiSelected,
            itemsAiRejected,
            itemsQueued,
            backlogDrain: drain,
          },
        });
        return mkResult(runId, category.id, source.platform, true, dryRun,
          { itemsFetched, itemsNew, itemsDuplicate, itemsAiSelected, itemsAiRejected, itemsQueued, durationMs: Date.now() - t0 });
      }
    }

    await markPhase('prepare_candidates');
    const maxCandidates = parseInt(env.AI_MAX_CANDIDATES_PER_RUN || '50', 10);
    const batch = fresh.slice(0, maxCandidates);
    const batchKeys = freshKeys.slice(0, maxCandidates);

    // ── Freshness pre-filter (section 11.5 fix) ───────────────
    // آیتم‌های قدیمی‌تر از freshness_hours را BEFORE AI فیلتر می‌کنیم
    // این کار هزینه AI را صرفه‌جویی می‌کند و freshness را قطعی اجرا می‌کند
    const cutoffTs = Math.floor(Date.now() / 1000) - category.freshness_hours * 3600;
    const freshBatch = batch.filter(item => item.publishedAt >= cutoffTs);
    const staleCount = batch.length - freshBatch.length;
    if (staleCount > 0) {
      console.log(`[Curation][${category.id}] Filtered ${staleCount} stale items (>${category.freshness_hours}h old)`);
      // Dedupe keys برای stale آیتم‌ها هم ثبت کن — جلوگیری از reprocess
      if (!dryRun) {
        for (let si = 0; si < batch.length; si++) {
          if (batch[si]!.publishedAt < cutoffTs) {
            const staleItemId = generateId('stale');
            await recordDedupeKeys(env, batchKeys[si]!, staleItemId);
          }
        }
      }
    }
    const freshnessKeptKeys = batchKeys.filter((_, i) => batch[i]!.publishedAt >= cutoffTs);

    const policyFilteredBatch: NormalizedItem[] = [];
    const policyFilteredKeys: string[][] = [];
    for (let pi = 0; pi < freshBatch.length; pi++) {
      const item = freshBatch[pi]!;
      const keys = freshnessKeptKeys[pi]!;
      const preAiRejectReason = getPreAiContentRejectReason(item, category);
      if (preAiRejectReason) {
        const itemId = generateId('item');
        await saveDiscoveryItem(env, itemId, runId, category.id, item, buildPolicyRejectAiResult(item, preAiRejectReason), 'ai_rejected', preAiRejectReason);
        itemsAiRejected++;
        if (!dryRun) await recordDedupeKeys(env, keys, itemId);
        continue;
      }
      policyFilteredBatch.push(item);
      policyFilteredKeys.push(keys);
    }

    const filteredBatch = policyFilteredBatch;
    const filteredBatchKeys = policyFilteredKeys;
    await markPhase('pre_ai_filters_complete');

    if (filteredBatch.length === 0) {
      await finishRun(env, runId, category.id, source.platform, effectiveDatasetId,
        dryRun ? 'dry_run' : 'completed', { itemsFetched, itemsNew, itemsDuplicate, itemsAiRejected, durationMs: Date.now() - t0 });
      return mkResult(runId, category.id, source.platform, true, dryRun,
        { itemsFetched, itemsNew, itemsDuplicate, itemsAiRejected, durationMs: Date.now() - t0 });
    }

    await markPhase('load_ai_context');
    const whitelist = await loadWhitelistedAccounts(env, category.id);
    const channels = await loadChannels(env, category.id);
    await markPhase('ai_gate');
    const aiResults = await runAIGate(env, filteredBatch, category, whitelist, channels);
    await recordRunEvent(env, {
      runId,
      eventType: 'ai.gate.success',
      phase: 'ai_gate',
      categoryId: category.id,
      platform: source.platform,
      sourceId: source.id,
      datasetId: effectiveDatasetId,
      durationMs: Date.now() - t0,
      metadata: {
        candidates: filteredBatch.length,
        results: aiResults.length,
        publishTrue: aiResults.filter(r => r.publish === true).length,
      },
    });
    await markPhase('ai_gate_complete');
    const semanticDedupeEnabledForRun = channels.some(channel => channel.semantic_dedupe_enabled !== 0);
    const similarTopicRejects = semanticDedupeEnabledForRun
      ? findSimilarTopicInRunRejections(filteredBatch, aiResults, category.score_threshold)
      : new Set<number>();

    await markPhase('persist_ai_results');
    for (let i = 0; i < filteredBatch.length; i++) {
      const item = filteredBatch[i]!;
      const ai   = aiResults[i]!;
      const keys = filteredBatchKeys[i]!;
      const itemId = generateId('item');
      const rejectReason = getItemRejectReason(ai, category, item, similarTopicRejects.has(i));
      const rejected = rejectReason !== null;
      await saveDiscoveryItem(env, itemId, runId, category.id, item, ai,
        rejected ? 'ai_rejected' : 'ai_selected', rejectReason);
      await recordRunItemEvent(env, {
        runId,
        itemId,
        sourceUrl: item.sourceUrl,
        postId: item.postId,
        sourceAccount: item.sourceAccount,
        phase: 'persist_ai_results',
        status: rejected ? 'ai_rejected' : 'ai_selected',
        rejectReason,
        aiScore: ai.score,
        aiRisk: ai.riskLevel,
        mediaCount: item.media.length,
        metadata: {
          publish: ai.publish,
          priority: ai.publishPriority,
          riskFlags: ai.riskFlags,
          topicFingerprint: ai.topicFingerprint,
          textOnlyPolicy: category.text_only_policy,
          scoreThreshold: category.score_threshold,
          minScoreForTextOnly: category.min_score_for_text_only,
          minScoreForMedia: category.min_score_for_media,
          similarTopicRejected: similarTopicRejects.has(i),
          mediaMode: category.media_mode,
          hasMedia: item.media.length > 0,
          textPreview: item.text.slice(0, 240),
        },
      });

      if (rejected) {
        itemsAiRejected++;
        if (!dryRun) await recordDedupeKeys(env, keys, itemId);
        continue;
      }
      itemsAiSelected++;
      if (dryRun) continue;

      await recordDedupeKeys(env, keys, itemId);
      await saveDiscoveryMedia(env, itemId, item);

      const mediaRes   = resolveMedia(item.media, category.media_mode as any);
      const mediaTypes = extractMediaTypes(item.media, category.media_mode as any);

      for (const channel of channels) {
        if (!channel.enabled) continue;
        const translationKey = channelTranslationKey(channel.id);
        const translation = ai.translations[translationKey] ?? ai.translations[channel.language];
        if (!translation) {
          console.warn(`[Orchestrator] No translation for ${channel.language}/${translationKey} — item ${itemId}`);
          await recordRunItemEvent(env, {
            runId,
            itemId,
            sourceUrl: item.sourceUrl,
            postId: item.postId,
            sourceAccount: item.sourceAccount,
            phase: 'persist_ai_results',
            status: 'translation_missing',
            aiScore: ai.score,
            aiRisk: ai.riskLevel,
            mediaCount: item.media.length,
            metadata: {
              channelId: channel.id,
              language: channel.language,
              translationKey,
              availableTranslationKeys: Object.keys(ai.translations ?? {}),
            },
          });
          continue;
        }
        const rule = await runRuleGate(env, ai, channel, item.mediaUrlExpiresSoon);
        if (!rule.approved || !rule.scheduledAt) {
          console.log(`[Orchestrator] Rule rejected: ${rule.reason} — channel ${channel.id}`);
          await recordRunItemEvent(env, {
            runId,
            itemId,
            sourceUrl: item.sourceUrl,
            postId: item.postId,
            sourceAccount: item.sourceAccount,
            phase: 'persist_ai_results',
            status: 'rule_gate_rejected',
            rejectReason: rule.reason,
            aiScore: ai.score,
            aiRisk: ai.riskLevel,
            mediaCount: item.media.length,
            metadata: {
              channelId: channel.id,
              language: channel.language,
              mediaUrlExpiresSoon: item.mediaUrlExpiresSoon,
              method: mediaRes.method,
            },
          });
          continue;
        }

        await saveQueueItem(env, {
          itemId,
          channelId: channel.id,
          language: channel.language,
          sourceUrl: item.sourceUrl,
          captionShort: translation.captionShort,
          captionFull: translation.captionFull,
          hashtags: translation.hashtags,
          method: mediaRes.method,
          mediaUrls: mediaRes.mediaUrls,
          thumbnailUrls: mediaRes.thumbnailUrls,
          mediaTypes,
          scheduledAt: rule.scheduledAt,
        });
        itemsQueued++;
        await recordRunItemEvent(env, {
          runId,
          itemId,
          sourceUrl: item.sourceUrl,
          postId: item.postId,
          sourceAccount: item.sourceAccount,
          phase: 'persist_ai_results',
          status: 'queue_created',
          aiScore: ai.score,
          aiRisk: ai.riskLevel,
          mediaCount: item.media.length,
          metadata: {
            channelId: channel.id,
            language: channel.language,
            method: mediaRes.method,
            scheduledAt: rule.scheduledAt,
            mediaTypes,
            mediaUrlCount: mediaRes.mediaUrls.length,
            thumbnailUrlCount: mediaRes.thumbnailUrls.length,
            itemsQueued,
          },
        });
      }
    }

    await markPhase('finalize');
    const finalStatus = dryRun ? 'dry_run' : 'completed';
    await finishRun(env, runId, category.id, source.platform, effectiveDatasetId,
      finalStatus, { itemsFetched, itemsNew, itemsDuplicate, itemsAiSelected, itemsAiRejected, itemsQueued, durationMs: Date.now() - t0 });
    await recordRunEvent(env, {
      runId,
      eventType: finalStatus === 'dry_run' ? 'run.dry_run_completed' : 'run.completed',
      phase: 'finalize',
      categoryId: category.id,
      platform: source.platform,
      sourceId: source.id,
      datasetId: effectiveDatasetId,
      durationMs: Date.now() - t0,
      metadata: {
        itemsFetched,
        itemsNew,
        itemsDuplicate,
        itemsAiSelected,
        itemsAiRejected,
        itemsQueued,
      },
    });
    return mkResult(runId, category.id, source.platform, true, dryRun,
      { itemsFetched, itemsNew, itemsDuplicate, itemsAiSelected, itemsAiRejected, itemsQueued, durationMs: Date.now() - t0 });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const phaseMsg = `phase=${phase}: ${msg}`;
    errors.push(phaseMsg);
    console.error(`[Curation][${category.id}/${source.platform}]`, phaseMsg);
    await finishRun(env, runId, category.id, source.platform, effectiveDatasetId,
      'failed', { itemsFetched, itemsNew, itemsDuplicate, itemsAiSelected, itemsAiRejected, itemsQueued, errorMessage: phaseMsg, durationMs: Date.now() - t0 });
    await recordRunEvent(env, {
      runId,
      eventType: itemsQueued > 0 ? 'run.failed_partial' : 'run.failed',
      phase,
      severity: 'error',
      message: phaseMsg,
      categoryId: category.id,
      platform: source.platform,
      sourceId: source.id,
      datasetId: effectiveDatasetId,
      durationMs: Date.now() - t0,
      metadata: {
        itemsFetched,
        itemsNew,
        itemsDuplicate,
        itemsAiSelected,
        itemsAiRejected,
        itemsQueued,
      },
    });
    return mkResult(runId, category.id, source.platform, false, dryRun, { itemsFetched, errors, durationMs: Date.now() - t0 });
  }
}


function computeCandidatePriorityScore(item: NormalizedItem): number {
  const views = Math.max(0, Number(item.engagementViews) || 0);
  const likes = Math.max(0, Number(item.engagementLikes) || 0);
  const shares = Math.max(0, Number(item.engagementShares) || 0);
  const mediaBoost = item.media.length > 0 ? 5 : 0;
  return Math.round(Math.log10(views + 10) * 10 + Math.log10(likes + shares * 2 + 10) * 5 + mediaBoost);
}


function channelTranslationKey(channelId: string): string {
  return `channel:${channelId}`;
}

// ── Publish due queue items (cron + manual admin trigger) ─────

export interface PublishDueOptions {
  /** Manual admin endpoint may provide a lower limit. Defaults to TELEGRAM_PUBLISH_DUE_LIMIT. */
  limit?: number;
  /** Cron requires the scheduler switch. Manual /internal/publish/due bypasses only this flag, not publish kill-switches. */
  requireScheduler?: boolean;
}

export interface PublishQueueItemOptions {
  /** Allowed source statuses for optimistic locking. */
  allowedStatuses?: QueuePublishableStatus[];
  /** Allow publishing even if scheduled_at is in the future. Used by publish-now. */
  bypassSchedule?: boolean;
  /** Keep channel rate limits by default. */
  respectRateLimits?: boolean;
  /** Test hook / deterministic timestamp. */
  now?: number;
}

type QueuePublishableStatus = 'scheduled' | 'retry' | 'failed';
type QueuePublishStatus = 'published' | 'failed' | 'retry' | 'skipped' | 'scheduled';

export interface PublishQueueItemResult {
  queueId: string;
  ok: boolean;
  status: QueuePublishStatus;
  reason?: string;
  telegramMessageId?: string;
  allMessageIds?: string[];
  error?: string;
}

export async function publishDueItems(
  env: Env,
  options: PublishDueOptions = {}
): Promise<{ published: number; failed: number; skipped: number }> {
  const runtime = await getRuntimeConfig(env);
  const requireScheduler = options.requireScheduler !== false;
  if (requireScheduler && !runtime.telegramSchedulerEnabled) return { published: 0, failed: 0, skipped: 0 };

  const limit = clampInt(
    options.limit ?? parseInt(env.TELEGRAM_PUBLISH_DUE_LIMIT || '5', 10),
    1,
    100
  );
  const now = Math.floor(Date.now() / 1000);

  const due = await env.DB.prepare(`
    SELECT q.id
    FROM publish_queue q
    JOIN channels c ON q.channel_id = c.id
    WHERE q.status IN ('scheduled', 'retry')
      AND q.scheduled_at <= ?
      AND c.publish_enabled = 1
      AND c.enabled = 1
    ORDER BY q.scheduled_at ASC
    LIMIT ?
  `).bind(now, limit).all<{ id: string }>();

  let published = 0, failed = 0, skipped = 0;

  for (const row of due.results ?? []) {
    const result = await publishQueueItem(env, row.id, {
      allowedStatuses: ['scheduled', 'retry'],
      bypassSchedule: false,
      respectRateLimits: true,
      now,
    });

    if (result.status === 'published') published++;
    else if (result.status === 'failed' || result.status === 'retry') failed++;
    else skipped++;
  }

  return { published, failed, skipped };
}

export async function publishQueueItem(
  env: Env,
  queueId: string,
  options: PublishQueueItemOptions = {},
): Promise<PublishQueueItemResult> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const allowedStatuses: QueuePublishableStatus[] = options.allowedStatuses ?? ['scheduled', 'retry'];
  const bypassSchedule = options.bypassSchedule === true;
  const respectRateLimits = options.respectRateLimits !== false;

  if (!isValidQueueStatusList(allowedStatuses)) {
    return { queueId, ok: false, status: 'skipped', reason: 'invalid_allowed_statuses' };
  }

  const row = await env.DB.prepare(`
    SELECT q.*, c.telegram_chat_id, c.max_per_hour, c.min_gap_minutes,
           c.publish_enabled, c.enabled, c.timezone, c.allowed_windows, c.blocked_windows
    FROM publish_queue q
    JOIN channels c ON q.channel_id = c.id
    WHERE q.id=?
  `).bind(queueId).first<any>();

  if (!row) return { queueId, ok: false, status: 'skipped', reason: 'queue_item_not_found' };
  if (!allowedStatuses.includes(row.status)) {
    return { queueId, ok: false, status: 'skipped', reason: `status_not_allowed:${row.status}` };
  }
  if (!bypassSchedule && Number(row.scheduled_at ?? 0) > now) {
    return { queueId, ok: false, status: 'skipped', reason: 'not_due' };
  }
  if (row.enabled !== 1 || row.publish_enabled !== 1) {
    return { queueId, ok: false, status: 'skipped', reason: 'channel_disabled' };
  }

  const windowReason = checkChannelPublishWindowAt({
    timezone: row.timezone ?? 'UTC',
    allowed_windows: row.allowed_windows ?? '[]',
    blocked_windows: row.blocked_windows ?? '[]',
  }, now);
  if (windowReason) return { queueId, ok: false, status: 'skipped', reason: windowReason };

  if (respectRateLimits) {
    const rateLimitReason = await checkChannelPublishRateLimits(env, row.channel_id, row.max_per_hour, row.min_gap_minutes, now);
    if (rateLimitReason) return { queueId, ok: false, status: 'skipped', reason: rateLimitReason };
  }

  const placeholders = allowedStatuses.map(() => '?').join(',');
  const locked = await env.DB
    .prepare(`UPDATE publish_queue SET status='publishing', scheduled_at=? WHERE id=? AND status IN (${placeholders})`)
    .bind(now, queueId, ...allowedStatuses).run();
  if (!locked.meta.changes) {
    return { queueId, ok: false, status: 'skipped', reason: 'optimistic_lock_failed' };
  }

  const channel = await loadChannelForPublish(env, row.channel_id);
  if (!channel) {
    await env.DB.prepare(`UPDATE publish_queue SET status='failed', publish_error=? WHERE id=?`)
      .bind('channel_not_found_or_disabled', queueId).run();
    return { queueId, ok: false, status: 'failed', reason: 'channel_not_found_or_disabled' };
  }

  const mediaUrls: string[] = safeJsonParse(row.media_urls, []);
  const thumbnailUrls: string[] = safeJsonParse(row.thumbnail_urls, []);
  const mediaTypes: Array<'image'|'video'> = safeJsonParse(row.media_types, []);
  const telegramFileIds = await loadTelegramFileIds(env, row.item_id, mediaUrls.length);
  const videoMetadata = await loadVideoMetadata(env, row.item_id, mediaUrls.length);

  const result = await publishToTelegram(env, {
    chatId:        channel.telegram_chat_id,
    captionShort:  row.caption_short ?? '',
    captionFull:   row.caption_full  ?? '',
    sourceUrl:     row.source_url    ?? '',
    method:        row.telegram_method ?? 'sendMessage',
    language:      row.language ?? channel.language,
    channel,
    mediaUrls,
    thumbnailUrls,
    mediaTypes,
    videoMetadata,
    telegramFileIds,
  });

  await syncDiscoveryMediaAfterPublish(env, row.item_id, result.mediaResults, result.ok ? undefined : result);

  if (result.ok && result.messageId !== 'disabled_skip') {
    const errorNote = result.captionError ? result.captionError.slice(0, 300) : null;
    const allIds = JSON.stringify(result.allMessageIds ?? []);

    await env.DB
      .prepare(`UPDATE publish_queue SET status='published', telegram_message_id=?, all_message_ids=?, published_at=?, publish_error=?, media_warning=? WHERE id=?`)
      .bind(result.messageId ?? '', allIds, now, errorNote, errorNote, queueId).run();

    return {
      queueId,
      ok: true,
      status: 'published',
      telegramMessageId: result.messageId,
      allMessageIds: result.allMessageIds ?? [],
      error: result.captionError,
    };
  }

  if (result.messageId === 'disabled_skip') {
    await env.DB.prepare(`UPDATE publish_queue SET status='scheduled' WHERE id=?`).bind(queueId).run();
    return { queueId, ok: true, status: 'scheduled', reason: 'publish_disabled' };
  }

  const retries = (row.retry_count ?? 0) + 1;
  const isFinal = retries >= 3;
  const retryDelay = result.retryAfterSec ? result.retryAfterSec + 10 : 30 * 60;
  const newStatus: 'failed' | 'retry' = isFinal ? 'failed' : 'retry';
  const newAt = isFinal ? now : now + retryDelay;
  const error = `[${result.errorType ?? 'unknown'}] ${(result.error ?? '').slice(0, 350)}`;

  await env.DB
    .prepare(`UPDATE publish_queue SET status=?, retry_count=?, scheduled_at=?, publish_error=? WHERE id=?`)
    .bind(newStatus, retries, newAt, error, queueId).run();

  return { queueId, ok: false, status: newStatus, reason: result.errorType ?? 'unknown', error };
}

async function checkChannelPublishRateLimits(
  env: Env,
  channelId: string,
  maxPerHour: number,
  minGapMinutes: number,
  now: number,
): Promise<string | null> {
  const hourAgo = now - 3600;
  const thisHour = await env.DB
    .prepare(`SELECT COUNT(*) as cnt FROM publish_queue WHERE channel_id=? AND status='published' AND published_at>?`)
    .bind(channelId, hourAgo).first<{ cnt: number }>();
  if ((thisHour?.cnt ?? 0) >= maxPerHour) return 'rate_limit_hourly';

  const lastPub = await env.DB
    .prepare(`SELECT published_at FROM publish_queue WHERE channel_id=? AND status='published' ORDER BY published_at DESC LIMIT 1`)
    .bind(channelId).first<{ published_at: number }>();
  if (lastPub && (now - lastPub.published_at) < minGapMinutes * 60) return 'rate_limit_min_gap';

  return null;
}

function isValidQueueStatusList(statuses: string[]): statuses is QueuePublishableStatus[] {
  return statuses.every(s => s === 'scheduled' || s === 'retry' || s === 'failed');
}

function clampInt(value: number, min: number, max: number): number {
  const n = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.max(min, Math.min(max, n));
}

// ── D1 helpers ────────────────────────────────────────────────

async function loadApifySources(env: Env): Promise<ApifySourceRow[]> {
  const r = await env.DB.prepare('SELECT * FROM apify_sources WHERE enabled=1').all<ApifySourceRow>();
  return r.results ?? [];
}
async function loadCategory(env: Env, id: string): Promise<CategoryRow | null> {
  return env.DB.prepare('SELECT * FROM categories WHERE id=? AND enabled=1').bind(id).first<CategoryRow>();
}
async function loadChannels(env: Env, categoryId: string): Promise<ChannelRow[]> {
  const r = await env.DB.prepare('SELECT * FROM channels WHERE category_id=? AND enabled=1').bind(categoryId).all<ChannelRow>();
  return r.results ?? [];
}
async function loadChannelForPublish(env: Env, channelId: string): Promise<ChannelRow | null> {
  return env.DB
    .prepare('SELECT * FROM channels WHERE id=? AND enabled=1 AND publish_enabled=1')
    .bind(channelId)
    .first<ChannelRow>();
}
async function loadWhitelistedAccounts(env: Env, categoryId: string): Promise<string[]> {
  const r = await env.DB
    .prepare(`SELECT account_handle FROM source_accounts WHERE category_id=? AND enabled=1 AND trust_level IN ('high','medium')`)
    .bind(categoryId).all<{ account_handle: string }>();
  return (r.results ?? []).map(x => x.account_handle);
}
async function saveDiscoveryRun(env: Env, id: string, categoryId: string, platform: string, datasetId: string, status: string): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO discovery_runs (id,category_id,platform,apify_dataset_id,status) VALUES (?,?,?,?,?)`)
    .bind(id, categoryId, platform, datasetId, status).run();
}
async function finishRun(env: Env, id: string, _c: string, _p: string, _d: string, status: string, data: Record<string, any>): Promise<void> {
  await env.DB.prepare(`
    UPDATE discovery_runs SET status=?,items_fetched=?,items_new=?,items_duplicate=?,
    items_ai_selected=?,items_ai_rejected=?,items_queued=?,error_message=?,duration_ms=?,
    completed_at=CASE WHEN ? IN ('completed','failed','dry_run') THEN CURRENT_TIMESTAMP ELSE completed_at END
    WHERE id=?
  `).bind(status, data.itemsFetched??0, data.itemsNew??0, data.itemsDuplicate??0,
    data.itemsAiSelected??0, data.itemsAiRejected??0, data.itemsQueued??0,
    data.errorMessage??null, data.durationMs??null, status, id).run();
}
async function saveDiscoveryItem(
  env: Env,
  id: string,
  runId: string,
  categoryId: string,
  item: NormalizedItem,
  ai: AIGateResult,
  status: 'ai_selected' | 'ai_rejected',
  rejectReason: string | null,
): Promise<void> {
  await env.DB.prepare(`
    INSERT OR IGNORE INTO discovery_items
    (id,run_id,category_id,platform,source_account,source_url,post_id,published_at,text,
    topic_fingerprint,media_count,media_expected_count,media_extracted_count,media_extraction_warnings,
    is_reply,is_retweet,is_quote,
    engagement_likes,engagement_shares,engagement_views,
    ai_score,ai_risk,ai_priority,risk_flags,status,reject_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(id, runId, categoryId, item.platform, item.sourceAccount, item.sourceUrl, item.postId,
    item.publishedAt, item.text.slice(0, 1000), ai.topicFingerprint, item.media.length,
    item.expectedMediaCount ?? item.media.length, item.media.length,
    JSON.stringify((item.mediaWarnings ?? []).slice(0, 20)),
    item.isReply === true ? 1 : 0, item.isRetweet === true ? 1 : 0, item.isQuote === true ? 1 : 0,
    item.engagementLikes, item.engagementShares, item.engagementViews,
    ai.score, ai.riskLevel, ai.publishPriority, JSON.stringify(ai.riskFlags), status, rejectReason).run();
}
async function saveDiscoveryMedia(env: Env, itemId: string, item: NormalizedItem): Promise<void> {
  for (let i = 0; i < item.media.length; i++) {
    const m = item.media[i]!;
    await env.DB.prepare(`
      INSERT OR IGNORE INTO discovery_media
      (id,item_id,media_index,media_type,source_url,thumbnail_url,width,height,duration_sec,size_mb,processing_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,'pending')
    `).bind(generateId('med'), itemId, i, m.type, m.url,
      m.thumbnailUrl ?? null, m.width ?? null, m.height ?? null,
      m.durationSec ?? null, m.sizeMb ?? null).run();
  }
}
async function saveQueueItem(env: Env, data: {
  itemId: string; channelId: string; language: string; sourceUrl: string;
  captionShort: string; captionFull: string; hashtags: string[];
  method: string; mediaUrls: string[]; thumbnailUrls: string[];
  mediaTypes: Array<'image'|'video'>; scheduledAt: number;
}): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO publish_queue
    (id,item_id,channel_id,language,source_url,caption_short,caption_full,hashtags,
    telegram_method,media_urls,thumbnail_urls,media_types,scheduled_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    generateId('q'), data.itemId, data.channelId, data.language, data.sourceUrl,
    data.captionShort, data.captionFull, JSON.stringify(data.hashtags),
    data.method, JSON.stringify(data.mediaUrls),
    JSON.stringify(data.thumbnailUrls), JSON.stringify(data.mediaTypes),
    data.scheduledAt
  ).run();
}

async function loadTelegramFileIds(env: Env, itemId: string, count: number): Promise<string[]> {
  if (count <= 0) return [];
  const rows = await env.DB.prepare(`
    SELECT media_index, telegram_file_id FROM discovery_media
    WHERE item_id=? AND telegram_file_id IS NOT NULL
    ORDER BY media_index ASC
  `).bind(itemId).all<{ media_index: number; telegram_file_id: string }>();
  const ids = Array(count).fill('') as string[];
  for (const row of rows.results ?? []) {
    if (row.media_index >= 0 && row.media_index < count && row.telegram_file_id) {
      ids[row.media_index] = row.telegram_file_id;
    }
  }
  return ids;
}

async function loadVideoMetadata(
  env: Env,
  itemId: string,
  count: number
): Promise<Array<{ width?: number; height?: number; durationSec?: number }>> {
  if (count <= 0) return [];

  const rows = await env.DB.prepare(`
    SELECT media_index, width, height, duration_sec
    FROM discovery_media
    WHERE item_id=?
    ORDER BY media_index ASC
  `).bind(itemId).all<{
    media_index: number;
    width: number | null;
    height: number | null;
    duration_sec: number | null;
  }>();

  const metadata = Array.from({ length: count }, () => ({} as { width?: number; height?: number; durationSec?: number }));

  for (const row of rows.results ?? []) {
    if (row.media_index >= 0 && row.media_index < count) {
      metadata[row.media_index] = {
        width: row.width ?? undefined,
        height: row.height ?? undefined,
        durationSec: row.duration_sec ?? undefined,
      };
    }
  }

  return metadata;
}


async function syncDiscoveryMediaAfterPublish(
  env: Env,
  itemId: string,
  mediaResults: PublishedMediaResult[] | undefined,
  publishFailure?: { errorType?: string; error?: string }
): Promise<void> {
  if (mediaResults && mediaResults.length > 0) {
    for (const media of mediaResults) {
      await env.DB.prepare(`
        UPDATE discovery_media SET
          processing_status=?,
          processing_error=?,
          telegram_file_id=COALESCE(?, telegram_file_id),
          telegram_message_id=COALESCE(?, telegram_message_id),
          thumbnail_status=COALESCE(?, thumbnail_status),
          thumbnail_error=COALESCE(?, thumbnail_error),
          validated_at=CASE WHEN ? IN ('ready','uploaded') THEN CURRENT_TIMESTAMP ELSE validated_at END
        WHERE item_id=? AND media_index=?
      `).bind(
        media.status,
        media.error ?? null,
        media.telegramFileId ?? null,
        media.telegramMessageId ?? null,
        media.thumbnailStatus ?? null,
        media.thumbnailError ?? null,
        media.status,
        itemId,
        media.mediaIndex,
      ).run();
    }
    return;
  }

  if (publishFailure && isMediaPublishFailure(publishFailure.errorType)) {
    await env.DB.prepare(`
      UPDATE discovery_media SET processing_status=?, processing_error=?
      WHERE item_id=? AND processing_status NOT IN ('uploaded')
    `).bind(
      mediaStatusFromPublishError(publishFailure.errorType),
      `[${publishFailure.errorType ?? 'unknown'}] ${(publishFailure.error ?? '').slice(0, 300)}`,
      itemId,
    ).run();
  }
}

function isMediaPublishFailure(errorType?: string): boolean {
  return ['media_error', 'file_too_large', 'expired_url', 'invalid_format'].includes(errorType ?? '');
}

function mediaStatusFromPublishError(errorType?: string): string {
  if (errorType === 'file_too_large') return 'too_large';
  if (errorType === 'expired_url') return 'expired';
  if (errorType === 'invalid_format' || errorType === 'media_error') return 'unsupported';
  return 'failed';
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
function safeJsonParse<T>(json: string, fallback: T): T {
  try { return JSON.parse(json) as T; } catch { return fallback; }
}
function mkResult(runId: string, categoryId: string, platform: string, ok: boolean, dryRun: boolean, p: Partial<CurationRunResult> = {}): CurationRunResult {
  return { runId, categoryId, platform, ok, dryRun,
    itemsFetched: p.itemsFetched??0, itemsNew: p.itemsNew??0, itemsDuplicate: p.itemsDuplicate??0,
    itemsAiSelected: p.itemsAiSelected??0, itemsAiRejected: p.itemsAiRejected??0,
    itemsQueued: p.itemsQueued??0, errors: p.errors??[], durationMs: p.durationMs??0 };
}
