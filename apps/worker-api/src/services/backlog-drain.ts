import type { Env, AICandidateRow, AICandidateStatus, AIGateResult, CategoryRow, ChannelRow, NormalizedItem } from '../types';
import { attachTranslations, runAIGate, scoreItems } from './ai-gate';
import { recordDedupeKeys } from './dedupe';
import { resolveMedia, extractMediaTypes } from './media-resolver';
import { runRuleGate } from './rule-gate';
import { recordRunEvent, recordRunItemEvent } from './run-events';
import {
  claimCandidateBatch,
  failMaxAttemptPendingCandidates,
  fetchPendingCandidates,
  getCandidateBacklogDrainLimit,
  getFairSourcePickerPoolMultiplier,
  getMaxScoringBatchesPerRun,
  getScoringBatchSize,
  isCandidateBacklogEnabled,
  isFairSourcePickerEnabled,
  recoverStaleScoringCandidates,
  releaseClaimedCandidatesToPending,
  skipStaleCandidates,
  updateCandidateStatus,
} from './candidate-queue';
import {
  buildPolicyRejectAiResult,
  findSimilarTopicInRunRejections,
  getItemRejectReason,
  getPreAiContentRejectReason,
} from './content-policy';
import { selectCandidateBatchForScoring } from './fair-source-picker';
import {
  buildCryptoStoryClusterKey,
  buildCryptoThemeKey,
  getCryptoThemeDailyCap,
  getSourceAudienceRejectReason,
} from './story-quality-guard';
import { getStarvingMaxBatches } from './queue-health';
import { runDuplicateAiJudgeForSurvivors } from './duplicate-ai-judge';
import { enrichAndBriefRssSurvivors } from './rss-brief';
import {
  getStoryIntelligenceWindowHours,
  isStoryFollowupAllowEnabled,
  isStoryIntelligenceEnabled,
  isStoryIntelligenceRejectActive,
  isSemanticStoryHeuristicRejectEnabled,
  isFollowUpEventType,
  recordStoryEvent,
  shouldRejectBySemanticStorySimilarity,
  shouldRejectByStoryKey,
  similarStorySeenInWindow,
  storyKeySeenInWindow,
} from './story-intelligence';

export interface BacklogDrainOptions {
  categoryId?: string;
  limit?: number;
  maxBatches?: number;
  skipStale?: boolean;
  recoverStale?: boolean;
  /** Phase 6F: temporary extra scoring-call budget while the queue is starving. */
  scoringCallBonus?: number;
}

export interface BacklogDrainResult {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  candidatesPulled: number;
  candidatesClaimed: number;
  candidatesScored: number;
  candidatesSelected: number;
  candidatesRejected: number;
  candidatesQueued: number;
  candidatesFailed: number;
  candidatesSkipped: number;
  batchesAttempted: number;
  stoppedByBudget: boolean;
  error?: string;
}

interface ScoringBudgetSnapshot {
  allowed: boolean;
  reason?: string;
  callsToday: number;
  tokensToday: number;
  maxCalls: number;
  tokenBudget: number;
}

const EMPTY_RESULT: BacklogDrainResult = {
  ok: true,
  skipped: false,
  candidatesPulled: 0,
  candidatesClaimed: 0,
  candidatesScored: 0,
  candidatesSelected: 0,
  candidatesRejected: 0,
  candidatesQueued: 0,
  candidatesFailed: 0,
  candidatesSkipped: 0,
  batchesAttempted: 0,
  stoppedByBudget: false,
};

export async function drainAICandidateQueue(env: Env, options: BacklogDrainOptions = {}): Promise<BacklogDrainResult> {
  if (!isCandidateBacklogEnabled(env)) {
    return { ...EMPTY_RESULT, skipped: true, reason: 'backlog_disabled' };
  }

  const result: BacklogDrainResult = { ...EMPTY_RESULT };

  if (options.recoverStale !== false) await recoverStaleScoringCandidates(env);
  await failMaxAttemptPendingCandidates(env);
  if (options.skipStale === true) {
    result.candidatesSkipped += await skipStaleCandidates(env);
  }

  // Phase 6F fix: when the queue-health controller passes an elevated
  // maxBatches (starving), clamp it against an INDEPENDENT hard cap — not the
  // normal per-run max — otherwise the controller's signal is silently lost.
  // Also raise the drain limit so the extra batches can actually be pulled.
  const scoringBatchSize = Math.max(1, getScoringBatchSize(env));
  const normalMaxBatches = getMaxScoringBatchesPerRun(env);
  const hardMaxBatches = Math.max(normalMaxBatches, getStarvingMaxBatches(env, normalMaxBatches), 1);
  const maxBatches = Math.max(1, Math.min(options.maxBatches ?? normalMaxBatches, hardMaxBatches));
  const baseDrainLimit = Math.max(1, Math.min(options.limit ?? getCandidateBacklogDrainLimit(env), getCandidateBacklogDrainLimit(env)));
  const drainLimit = Math.max(baseDrainLimit, maxBatches * scoringBatchSize);
  const batchSize = Math.max(1, Math.min(scoringBatchSize, drainLimit));

  // Set once the RSS brief daily cap is hit in this tick. Subsequent fetches then
  // exclude RSS at the SQL level so the cap defers ONLY RSS — non-RSS candidates
  // (which sort behind RSS by priority_score) keep draining instead of starving.
  let rssBudgetExhausted = false;

  for (let batchNo = 0; batchNo < maxBatches && result.candidatesPulled < drainLimit; batchNo++) {
    const remaining = drainLimit - result.candidatesPulled;
    const fairPickerEnabled = isFairSourcePickerEnabled(env);
    const poolLimit = fairPickerEnabled
      ? Math.min(Math.max(batchSize * getFairSourcePickerPoolMultiplier(env), batchSize), 200)
      : Math.min(batchSize, remaining);
    const pendingPool = await fetchPendingCandidates(env, poolLimit, options.categoryId, rssBudgetExhausted ? 'rss' : undefined);
    if (pendingPool.length === 0) break;

    const selection = selectCandidateBatchForScoring(pendingPool, Math.min(batchSize, remaining), fairPickerEnabled);
    const pending = selection.selected;
    if (pending.length === 0) break;
    result.candidatesPulled += pending.length;

    const budget = await checkScoringBudgetForBacklog(env, options.scoringCallBonus ?? 0);
    if (!budget.allowed) {
      result.stoppedByBudget = true;
      result.error = budget.reason;
      await recordRunEvent(env, {
        runId: pending[0]?.run_id ?? 'backlog_drain',
        eventType: 'candidate.batch.budget_stopped',
        phase: 'ai_candidate_backlog',
        severity: 'warn',
        message: budget.reason,
        categoryId: options.categoryId,
        metadata: { ...budget, fairSourcePicker: selection.stats },
      });
      break;
    }

    const claimed = await claimCandidateBatch(env, pending);
    if (claimed.length === 0) continue;
    result.candidatesClaimed += claimed.length;
    result.batchesAttempted++;

    const batchResult = await processClaimedBatch(env, claimed, options.scoringCallBonus ?? 0);
    result.candidatesScored += batchResult.scored;
    result.candidatesSelected += batchResult.selected;
    result.candidatesRejected += batchResult.rejected;
    result.candidatesQueued += batchResult.queued;
    result.candidatesFailed += batchResult.failed;
    result.candidatesSkipped += batchResult.skipped;
    // RSS brief cap: defer RSS for the rest of this tick but keep draining
    // non-RSS. Must be checked BEFORE the generic budget break below.
    if (batchResult.rssBudgetExhausted) {
      rssBudgetExhausted = true;
      if (!result.error) result.error = batchResult.error;
    }
    if (batchResult.stoppedByBudget) {
      result.stoppedByBudget = true;
      result.error = batchResult.error;
      break;
    }
  }

  return result;
}

async function processClaimedBatch(env: Env, rows: AICandidateRow[], scoringCallBonus = 0): Promise<{
  scored: number;
  selected: number;
  rejected: number;
  queued: number;
  failed: number;
  skipped: number;
  stoppedByBudget: boolean;
  /** RSS brief daily cap hit: stop pulling RSS for the rest of this tick WITHOUT
   *  stopping non-RSS drain (unlike stoppedByBudget, which halts everything). */
  rssBudgetExhausted?: boolean;
  error?: string;
}> {
  const zero = { scored: 0, selected: 0, rejected: 0, queued: 0, failed: 0, skipped: 0, stoppedByBudget: false };
  const first = rows[0];
  if (!first) return zero;

  const category = await loadCategory(env, first.category_id);
  if (!category) {
    await releaseClaimedCandidatesToPending(env, rows.map(r => r.id), 'category_not_found', { decrementAttempt: true });
    return { ...zero, failed: rows.length, error: 'category_not_found' };
  }

  const budget = await checkScoringBudgetForBacklog(env, scoringCallBonus);
  if (!budget.allowed) {
    await releaseClaimedCandidatesToPending(env, rows.map(r => r.id), budget.reason ?? 'ai_budget_exceeded', { decrementAttempt: true });
    return { ...zero, stoppedByBudget: true, error: budget.reason };
  }

  const prepared: Array<{ row: AICandidateRow; item: NormalizedItem; keys: string[] }> = [];
  let skipped = 0;
  let rejected = 0;
  // Set when the RSS brief daily cap is hit so the outer drain loop stops pulling
  // RSS (and does not re-claim the just-released cap-deferred candidates) for the
  // rest of this tick — while letting non-RSS candidates keep draining.
  let rssBriefCapHit = false;

  const cutoffTs = Math.floor(Date.now() / 1000) - category.freshness_hours * 3600;
  for (const row of rows) {
    const parsed = parseCandidateRow(row);
    if (!parsed) {
      await updateCandidateStatus(env, row.id, 'failed', { lastError: 'invalid_candidate_payload' });
      skipped++;
      continue;
    }

    if (parsed.item.publishedAt < cutoffTs) {
      const itemId = itemIdForCandidate(row.id);
      const ai = buildPolicyRejectAiResult(parsed.item, 'stale_before_ai');
      await saveDiscoveryItem(env, itemId, row.run_id ?? 'backlog', row.category_id, parsed.item, ai, 'ai_rejected', 'stale_before_ai');
      await recordDedupeKeys(env, parsed.keys, itemId);
      await updateCandidateStatus(env, row.id, 'ai_rejected', { lastError: 'stale_before_ai' });
      await recordCandidateItemEvent(env, row, itemId, parsed.item, 'ai_rejected', 'stale_before_ai', ai);
      rejected++;
      continue;
    }

    const preAiReject = getPreAiContentRejectReason(parsed.item, category);
    if (preAiReject) {
      const itemId = itemIdForCandidate(row.id);
      const ai = buildPolicyRejectAiResult(parsed.item, preAiReject);
      await saveDiscoveryItem(env, itemId, row.run_id ?? 'backlog', row.category_id, parsed.item, ai, 'ai_rejected', preAiReject);
      await recordDedupeKeys(env, parsed.keys, itemId);
      await updateCandidateStatus(env, row.id, 'ai_rejected', { lastError: preAiReject });
      await recordCandidateItemEvent(env, row, itemId, parsed.item, 'ai_rejected', preAiReject, ai);
      rejected++;
      continue;
    }

    prepared.push({ row, item: parsed.item, keys: parsed.keys });
  }

  if (prepared.length === 0) return { ...zero, rejected, skipped };

  const whitelist = await loadWhitelistedAccounts(env, category.id);
  const channels = await loadChannels(env, category.id);
  const items = prepared.map(x => x.item);
  // Full per-item attribution context (used only when AI_COST_ATTRIBUTION_ENABLED).
  const attributionItems = prepared.map(x => ({
    sourceAccount: x.item.sourceAccount,
    sourceId: x.row.source_id ?? null,
    candidateId: x.row.id,
    discoveryItemId: itemIdForCandidate(x.row.id),
    channelId: channels[0]?.id ?? null,
  }));

  let aiResults: AIGateResult[];
  const translateAfterGates = String((env as any).BACKLOG_TRANSLATE_AFTER_GATES_ENABLED ?? '').toLowerCase() === 'true';
  try {
    // Phase 6H: when enabled, only SCORE here (cheap Claude batch). Translation
    // (the expensive Gemini step) is deferred until after the deterministic
    // dedupe/theme/audience gates, so we never pay to translate items that get
    // rejected. When disabled, behavior is identical to before (runAIGate).
    aiResults = translateAfterGates
      ? await scoreItems(env, items, category, whitelist, channels, attributionItems)
      : await runAIGate(env, items, category, whitelist, channels);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await releaseClaimedCandidatesToPending(env, prepared.map(x => x.row.id), `scoring_error: ${msg}`);
    return { ...zero, rejected, skipped, error: msg };
  }

  if (aiResults.some(ai => ai.riskFlags?.includes('ai_budget_exceeded'))) {
    await releaseClaimedCandidatesToPending(env, prepared.map(x => x.row.id), 'ai_budget_exceeded', { decrementAttempt: true });
    return { ...zero, rejected, skipped, stoppedByBudget: true, error: 'ai_budget_exceeded' };
  }

  const similarTopicRejects = channels.some(channel => channel.semantic_dedupe_enabled !== 0)
    ? findSimilarTopicInRunRejections(items, aiResults, category.score_threshold)
    : new Set<number>();

  let selected = 0;
  let queued = 0;

  if (!translateAfterGates) {
    // ── Legacy path: decide + queue interleaved (unchanged behavior). ──
    for (let i = 0; i < prepared.length; i++) {
      const candidate = prepared[i]!;
      const ai = aiResults[i];
      if (!ai) {
        await releaseClaimedCandidatesToPending(env, [candidate.row.id], 'missing_ai_result');
        continue;
      }
      // FIX: an item the model never actually scored (its URL/post_id was absent
      // from Claude's batch response) must be RETRIED, not buried as ai_rejected.
      // decrementAttempt:false so attempt_count still climbs and caps runaway retries.
      if (ai.riskFlags?.includes('not_scored')) {
        await releaseClaimedCandidatesToPending(env, [candidate.row.id], 'not_scored_retry');
        skipped += 1;
        continue;
      }

      const ev = await evaluateCandidateDb(env, channels, candidate, ai);
      const rejectReason = resolveCandidateRejectReason(ev, ai, category, candidate.item, similarTopicRejects.has(i));
      const counts = await persistCandidateDecision(env, channels, category, candidate, ai, ev, rejectReason);
      selected += counts.selected;
      rejected += counts.rejected;
      queued += counts.queued;
    }
    return { ...zero, scored: prepared.length, selected, rejected, queued, skipped };
  }

  // ── Phase 6H path: decide everything, translate survivors, then queue. ──
  const seenFingerprints = new Set<string>();
  const seenStoryClusters = new Set<string>();
  const seenStoryKeys = new Set<string>();
  const seenSemanticStories: Array<{
    storyKey: string | null;
    fields: AIGateResult['storyFields'] | null;
    topicFingerprint: string | null;
    eventType: string | null;
    text: string | null;
  }> = [];
  const themeBatchCounts = new Map<string, number>();
  const decisions: Array<{
    candidate: typeof prepared[number];
    ai: AIGateResult;
    ev: CandidateEvaluation;
    rejectReason: string | null;
  } | null> = [];

  for (let i = 0; i < prepared.length; i++) {
    const candidate = prepared[i]!;
    const ai = aiResults[i];
    if (!ai) {
      await releaseClaimedCandidatesToPending(env, [candidate.row.id], 'missing_ai_result');
      decisions.push(null);
      continue;
    }
    // FIX: model never scored this item (absent from Claude batch response) →
    // retry instead of burying as ai_rejected. attempt_count still caps retries.
    if (ai.riskFlags?.includes('not_scored')) {
      await releaseClaimedCandidatesToPending(env, [candidate.row.id], 'not_scored_retry');
      decisions.push(null);
      skipped += 1;
      continue;
    }

    const ev = await evaluateCandidateDb(env, channels, candidate, ai);

    // Intra-batch dedupe: items earlier in this same batch are not yet in the
    // DB, so mirror the legacy "queued rows block later items" behavior with
    // in-memory sets that we update only when an item survives the gates.
    const fpNorm = normalizeFingerprintForBatch(ai.topicFingerprint);
    if (!ev.recentTopicDuplicate && fpNorm && seenFingerprints.has(fpNorm)) ev.recentTopicDuplicate = true;
    if (!ev.recentStoryClusterDuplicate && ev.storyClusterKey && seenStoryClusters.has(ev.storyClusterKey)) ev.recentStoryClusterDuplicate = true;
    // Phase 6K intra-batch story-key dedup (only when reject is active).
    if (!ev.storyKeyRejectReason && ev.storyKey
        && isStoryIntelligenceRejectActive(env)
        && seenStoryKeys.has(ev.storyKey)
        && !(isStoryFollowupAllowEnabled(env) && isFollowUpEventType(ai.storyFields?.eventType))) {
      ev.storyKeyRejectReason = 'similar_story_key_recent_channel';
    }
    if (!ev.storyKeyRejectReason && isStoryIntelligenceRejectActive(env) && isSemanticStoryHeuristicRejectEnabled(env)) {
      const currentSemanticStory = {
        storyKey: ev.storyKey,
        fields: ai.storyFields ?? null,
        topicFingerprint: ai.topicFingerprint ?? null,
        eventType: ai.storyFields?.eventType ?? null,
        text: candidate.item.text ?? null,
      };
      for (const prior of seenSemanticStories) {
        if (shouldRejectBySemanticStorySimilarity({
          rejectEnabled: true,
          current: currentSemanticStory,
          prior,
          followupAllowEnabled: isStoryFollowupAllowEnabled(env),
        })) {
          ev.storyKeyRejectReason = 'similar_semantic_story_recent_batch';
          break;
        }
      }
    }
    if (!ev.themeCapRejectReason && ev.themeKey) {
      const cap = getCryptoThemeDailyCap(ev.themeKey, env); // IMPROVEMENT #4: env-overridable
      if (cap != null && (themeBatchCounts.get(ev.themeKey) ?? 0) >= cap) {
        ev.themeCapRejectReason = `theme_daily_cap:${ev.themeKey}`;
      }
    }

    const rejectReason = resolveCandidateRejectReason(ev, ai, category, candidate.item, similarTopicRejects.has(i));
    if (rejectReason === null) {
      if (fpNorm) seenFingerprints.add(fpNorm);
      if (ev.storyClusterKey) seenStoryClusters.add(ev.storyClusterKey);
      if (ev.storyKey) seenStoryKeys.add(ev.storyKey);
      seenSemanticStories.push({
        storyKey: ev.storyKey,
        fields: ai.storyFields ?? null,
        topicFingerprint: ai.topicFingerprint ?? null,
        eventType: ai.storyFields?.eventType ?? null,
        text: candidate.item.text ?? null,
      });
      if (ev.themeKey) themeBatchCounts.set(ev.themeKey, (themeBatchCounts.get(ev.themeKey) ?? 0) + 1);
    }
    decisions.push({ candidate, ai, ev, rejectReason });
  }

  // Translate ONLY survivors (cost saving) — one batched call.
  let survivorIdx = decisions
    .map((d, i) => (d && d.rejectReason === null ? i : -1))
    .filter(i => i >= 0);

  // Final pre-translation AI duplicate judge. Batched + daily-capped, so it
  // checks only publish-eligible survivors instead of every scraped item.
  if (survivorIdx.length > 0) {
    const judgeRejected = await runDuplicateAiJudgeForSurvivors(env, {
      categoryId: category.id,
      channelId: channels[0]?.id ?? null,
      candidates: survivorIdx.map(i => ({
        index: i,
        item: prepared[i]!.item,
        ai: decisions[i]!.ai,
      })),
    });

    for (const [i, judge] of judgeRejected) {
      const decision = decisions[i];
      if (!decision || decision.rejectReason !== null) continue;
      decision.rejectReason = 'similar_ai_duplicate_recent_channel';
      decision.ai = {
        ...decision.ai,
        riskFlags: Array.from(new Set([
          ...(decision.ai.riskFlags ?? []),
          'ai_duplicate_judge',
          `ai_duplicate_confidence:${judge.confidence.toFixed(2)}`,
        ])).slice(0, 10),
      };
    }

    if (judgeRejected.size > 0) {
      survivorIdx = decisions
        .map((d, i) => (d && d.rejectReason === null ? i : -1))
        .filter(i => i >= 0);
    }
  }

  if (survivorIdx.length > 0) {
    // Mixed batches (Apify X + RSS) take separate caption paths and fail
    // independently — an RSS brief failure must never strand X survivors and
    // vice-versa.
    const nonRssSurvivorIdx = survivorIdx.filter(i => prepared[i]!.item.platform !== 'rss');
    const rssSurvivorIdx = survivorIdx.filter(i => prepared[i]!.item.platform === 'rss');

    // ── Non-RSS survivors: existing translation path (behavior UNCHANGED) ──
    if (nonRssSurvivorIdx.length > 0) {
      const survivorItems = nonRssSurvivorIdx.map(i => prepared[i]!.item);
      const survivorAi = nonRssSurvivorIdx.map(i => decisions[i]!.ai);
      const survivorAttribution = nonRssSurvivorIdx.map(i => ({
        sourceAccount: prepared[i]!.item.sourceAccount,
        sourceId: prepared[i]!.row.source_id ?? null,
        candidateId: prepared[i]!.row.id,
        discoveryItemId: itemIdForCandidate(prepared[i]!.row.id),
        channelId: channels[0]?.id ?? null,
      }));
      try {
        const translated = await attachTranslations(env, survivorItems, survivorAi, category, channels, survivorAttribution);
        nonRssSurvivorIdx.forEach((i, k) => { decisions[i]!.ai = translated[k]!; });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[BacklogDrain] attachTranslations failed; releasing survivors to retry:', msg);
        await releaseClaimedCandidatesToPending(
          env,
          nonRssSurvivorIdx.map(i => prepared[i]!.row.id),
          `translation_error: ${msg}`,
          { decrementAttempt: true },
        );
        nonRssSurvivorIdx.forEach(i => { decisions[i] = null; });
        skipped += nonRssSurvivorIdx.length;
      }
    }

    // ── RSS survivors: copyright-safe Persian brief (isolated failure) ──
    if (rssSurvivorIdx.length > 0) {
      const items = rssSurvivorIdx.map(i => prepared[i]!.item);
      const ais = rssSurvivorIdx.map(i => decisions[i]!.ai);
      const labels = rssSurvivorIdx.map(i => prepared[i]!.item.sourceAccount);
      try {
        const { results: briefed, failedIndexes, capDeferredIndexes } = await enrichAndBriefRssSurvivors(env, items, ais, category, channels, labels);
        rssSurvivorIdx.forEach((i, k) => { decisions[i]!.ai = briefed[k]!; });

        // Per-item brief failures: release ONLY those candidates to pending and
        // drop them from this tick's decisions so they are not persisted (which
        // would record dedupe_keys and never retry). Local index k → original i.
        if (failedIndexes.length > 0) {
          const failedOriginalIdx = failedIndexes.map(k => rssSurvivorIdx[k]!);
          await releaseClaimedCandidatesToPending(
            env,
            failedOriginalIdx.map(i => prepared[i]!.row.id),
            'rss_brief_unavailable',
            { decrementAttempt: true },
          );
          failedOriginalIdx.forEach(i => { decisions[i] = null; });
          skipped += failedOriginalIdx.length;
        }

        // Daily-cap-deferred survivors: release to pending with the attempt
        // DECREMENTED so repeated deferral never burns attempt_count toward
        // max-attempts (which would falsely 'fail' a healthy article). They are
        // not persisted (no premature dedupe_keys) and retry once budget frees.
        if (capDeferredIndexes.length > 0) {
          const deferredOriginalIdx = capDeferredIndexes.map(k => rssSurvivorIdx[k]!);
          await releaseClaimedCandidatesToPending(
            env,
            deferredOriginalIdx.map(i => prepared[i]!.row.id),
            'rss_brief_daily_cap',
            { decrementAttempt: true },
          );
          deferredOriginalIdx.forEach(i => { decisions[i] = null; });
          skipped += deferredOriginalIdx.length;
          rssBriefCapHit = true;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[BacklogDrain] RSS brief failed; releasing RSS survivors to retry:', msg);
        await releaseClaimedCandidatesToPending(
          env,
          rssSurvivorIdx.map(i => prepared[i]!.row.id),
          `rss_brief_error: ${msg}`,
          { decrementAttempt: true },
        );
        rssSurvivorIdx.forEach(i => { decisions[i] = null; });
        skipped += rssSurvivorIdx.length;
      }
    }
  }

  for (const decision of decisions) {
    if (!decision) continue;
    const { candidate, ai, ev, rejectReason } = decision;
    const counts = await persistCandidateDecision(env, channels, category, candidate, ai, ev, rejectReason);
    selected += counts.selected;
    rejected += counts.rejected;
    queued += counts.queued;
  }

  return {
    ...zero,
    scored: prepared.length, selected, rejected, queued, skipped,
    // RSS brief cap is platform-scoped: signal the outer loop to stop pulling RSS
    // for the rest of this tick (so the just-released cap-deferred RSS candidates
    // are not re-claimed) WITHOUT halting the non-RSS backlog.
    rssBudgetExhausted: rssBriefCapHit,
    ...(rssBriefCapHit && { error: 'rss_brief_daily_cap' }),
  };
}

// ── Phase 6H helpers (shared by both paths) ───────────────────

interface CandidateEvaluation {
  itemId: string;
  storyClusterKey: string | null;
  themeKey: string | null;
  recentTopicDuplicate: boolean;
  recentStoryClusterDuplicate: boolean;
  themeCapRejectReason: string | null;
  audienceRejectReason: string | null;
  storyKey: string | null;
  storyKeyRejectReason: string | null;
}

function normalizeFingerprintForBatch(value: unknown): string | null {
  const fp = String(value ?? '').trim().toLowerCase();
  if (!fp || fp.startsWith('ns-') || fp.startsWith('fp-') || fp.startsWith('err-') || fp.startsWith('budget-')) return null;
  return fp;
}

async function evaluateCandidateDb(
  env: Env,
  channels: ChannelRow[],
  candidate: { item: NormalizedItem; row: AICandidateRow; keys: string[] },
  ai: AIGateResult,
): Promise<CandidateEvaluation> {
  const itemId = itemIdForCandidate(candidate.row.id);
  const storyClusterKey = buildCryptoStoryClusterKey(ai.topicFingerprint, candidate.item.text, candidate.item.sourceAccount);
  const themeKey = buildCryptoThemeKey(ai.topicFingerprint, candidate.item.text, candidate.item.sourceAccount);
  const recentTopicDuplicate = await hasRecentTopicMatchForAnySemanticChannel(env, channels, ai.topicFingerprint);
  const recentStoryClusterDuplicate = await hasRecentStoryClusterMatchForAnySemanticChannel(env, channels, storyClusterKey);
  const themeCapRejectReason = await getThemeCapRejectReason(env, channels, themeKey);
  const audienceRejectReason = getSourceAudienceRejectReason(candidate.item, ai);

  // Phase 6K: story-key de-dup (active only when ENABLED + REJECT_ENABLED).
  const storyKey = ai.storyKey ?? null;
  let storyKeyRejectReason: string | null = null;
  if (storyKey && isStoryIntelligenceRejectActive(env)) {
    const channelId = channels[0]?.id ?? null;
    const seen = await storyKeySeenInWindow(env, {
      categoryId: candidate.row.category_id,
      channelId,
      storyKey,
      windowHours: getStoryIntelligenceWindowHours(env),
    });
    if (shouldRejectByStoryKey({
      rejectEnabled: true,
      storyKeySeenInWindow: seen,
      eventType: ai.storyFields?.eventType,
      followupAllowEnabled: isStoryFollowupAllowEnabled(env),
    })) {
      storyKeyRejectReason = 'similar_story_key_recent_channel';
    }

    if (!storyKeyRejectReason && isSemanticStoryHeuristicRejectEnabled(env)) {
      const semanticallySeen = await similarStorySeenInWindow(env, {
        categoryId: candidate.row.category_id,
        channelId,
        storyKey,
        fields: ai.storyFields ?? null,
        topicFingerprint: ai.topicFingerprint,
        eventType: ai.storyFields?.eventType ?? null,
        text: candidate.item.text ?? null,
        windowHours: getStoryIntelligenceWindowHours(env),
        followupAllowEnabled: isStoryFollowupAllowEnabled(env),
      });
      if (semanticallySeen) storyKeyRejectReason = 'similar_semantic_story_recent_channel';
    }
  }

  return { itemId, storyClusterKey, themeKey, recentTopicDuplicate, recentStoryClusterDuplicate, themeCapRejectReason, audienceRejectReason, storyKey, storyKeyRejectReason };
}

function resolveCandidateRejectReason(
  ev: CandidateEvaluation,
  ai: AIGateResult,
  category: CategoryRow,
  item: NormalizedItem,
  similarTopicRejected: boolean,
): string | null {
  return ev.recentTopicDuplicate
    ? 'similar_topic_recent_channel'
    : ev.recentStoryClusterDuplicate
      ? 'similar_story_cluster_recent_channel'
      : ev.storyKeyRejectReason
        ?? ev.themeCapRejectReason
        ?? ev.audienceRejectReason
        ?? getItemRejectReason(ai, category, item, similarTopicRejected);
}

/**
 * Persist one candidate decision and, when accepted, run the publish gates and
 * queue per channel. Returns count deltas. Shared by both drain paths so the
 * legacy behavior and the gated-translation behavior cannot drift apart.
 */
async function persistCandidateDecision(
  env: Env,
  channels: ChannelRow[],
  category: CategoryRow,
  candidate: { item: NormalizedItem; row: AICandidateRow; keys: string[] },
  ai: AIGateResult,
  ev: CandidateEvaluation,
  rejectReason: string | null,
): Promise<{ selected: number; rejected: number; queued: number }> {
  const itemId = ev.itemId;
  const isRejected = rejectReason !== null;

  await saveDiscoveryItem(env, itemId, candidate.row.run_id ?? 'backlog', candidate.row.category_id, candidate.item, ai, isRejected ? 'ai_rejected' : 'ai_selected', rejectReason);
  await recordCandidateItemEvent(env, candidate.row, itemId, candidate.item, isRejected ? 'ai_rejected' : 'ai_selected', rejectReason, ai, {
    topicFingerprint: ai.topicFingerprint,
    storyClusterKey: ev.storyClusterKey,
    themeKey: ev.themeKey,
    recentTopicDuplicate: ev.recentTopicDuplicate,
    recentStoryClusterDuplicate: ev.recentStoryClusterDuplicate,
    themeCapRejectReason: ev.themeCapRejectReason,
    audienceRejectReason: ev.audienceRejectReason,
    storyKey: ai.storyKey ?? null, // Phase 6K observe-only: recorded, not enforced
  });

  // Phase 6K: also record into the queryable story_intelligence_events table
  // (needs migration 0019) so de-dup/reporting can use an indexed lookup.
  // IMPORTANT: at this point an AI-selected item has NOT yet been queued — it
  // may still fail the rule gate, lack a translation, or hit the source cap. So
  // we record 'selected' here and only record 'queued' after a real
  // publish_queue row is inserted (below). This prevents a never-queued "ghost"
  // from locking a story_key and blocking a better version of the same story.
  if (ai.storyKey && isStoryIntelligenceEnabled(env)) {
    await recordStoryEvent(env, {
      categoryId: candidate.row.category_id,
      channelId: channels[0]?.id ?? null,
      storyKey: ai.storyKey,
      fields: ai.storyFields ?? null,
      topicFingerprint: ai.topicFingerprint,
      sourceId: candidate.row.source_id ?? null,
      sourceAccount: candidate.item.sourceAccount ?? null,
      discoveryItemId: itemId,
      candidateId: candidate.row.id,
      status: isRejected ? 'rejected' : 'selected',
    });
  } else if (isStoryIntelligenceEnabled(env)) {
    // 6K is on but the model returned no usable story fields — track it so the
    // report can surface a missing_pct instead of looking falsely healthy.
    await recordStoryEvent(env, {
      categoryId: candidate.row.category_id,
      channelId: channels[0]?.id ?? null,
      storyKey: '__missing__',
      fields: null,
      topicFingerprint: ai.topicFingerprint,
      sourceId: candidate.row.source_id ?? null,
      sourceAccount: candidate.item.sourceAccount ?? null,
      discoveryItemId: itemId,
      candidateId: candidate.row.id,
      status: 'story_key_missing',
    });
  }

  if (isRejected) {
    await recordDedupeKeys(env, candidate.keys, itemId);
    await updateCandidateStatus(env, candidate.row.id, 'ai_rejected', { lastError: rejectReason ?? undefined });
    return { selected: 0, rejected: 1, queued: 0 };
  }

  await recordDedupeKeys(env, candidate.keys, itemId);
  await saveDiscoveryMedia(env, itemId, candidate.item);

  const mediaRes = resolveMedia(candidate.item.media, category.media_mode as any);
  const mediaTypes = extractMediaTypes(candidate.item.media, category.media_mode as any);
  let candidateQueued = 0;
  let translationMissingCount = 0; // PATCH D: track translation_missing across channels
  // v4.1: define enabledChannels/Count up front so the needs_translation lastError
  // (translationMissingCount/enabledChannelCount) has a defined denominator.
  const enabledChannels = channels.filter(channel => channel.enabled);
  const enabledChannelCount = enabledChannels.length;

  for (const channel of enabledChannels) {
    const translationKey = channelTranslationKey(channel.id);
    const translation = ai.translations[translationKey] ?? ai.translations[channel.language];
    if (!translation) {
      translationMissingCount++; // PATCH D
      await recordCandidateItemEvent(env, candidate.row, itemId, candidate.item, 'translation_missing', 'translation_missing', ai, { channelId: channel.id, language: channel.language });
      continue;
    }

    const rule = await runRuleGate(env, ai, channel, candidate.item.mediaUrlExpiresSoon);
    if (!rule.approved || !rule.scheduledAt) {
      await recordCandidateItemEvent(env, candidate.row, itemId, candidate.item, 'rule_gate_rejected', rule.reason ?? 'rule_gate_rejected', ai, { channelId: channel.id, language: channel.language });
      continue;
    }

    if (normalizeAccount(candidate.item.sourceAccount) === 'whale_alert') {
      const alreadyQueued = await countRecentWhaleAlertQueueItems(env, channel.id);
      if (alreadyQueued >= 2) {
        await recordCandidateItemEvent(env, candidate.row, itemId, candidate.item, 'rule_gate_rejected', 'whale_alert_daily_cap', ai, { channelId: channel.id, language: channel.language, alreadyQueued });
        continue;
      }
    }

    // Phase 6I: enforce channels.max_posts_per_source_per_day. This column is
    // configured in production (=5) but was never enforced anywhere, which is
    // why a few outlets dominated the channel. Flag-gated + null-safe so the
    // default behavior is unchanged until the operator opts in.
    if (isSourceDailyCapEnabled(env) && channel.max_posts_per_source_per_day != null) {
      const cap = channel.max_posts_per_source_per_day;
      const alreadyFromSource = await countTodaysQueueItemsForSource(env, channel.id, candidate.item.sourceAccount);
      if (alreadyFromSource >= cap) {
        await recordCandidateItemEvent(env, candidate.row, itemId, candidate.item, 'rule_gate_rejected', 'source_daily_cap', ai, { channelId: channel.id, language: channel.language, sourceAccount: candidate.item.sourceAccount, alreadyFromSource, cap });
        continue;
      }
    }

    const scheduledAt = await adjustScheduledAtForFairSourceSpacing(env, channel, candidate.item.sourceAccount, rule.scheduledAt);
    const inserted = await saveQueueItem(env, {
      candidateId: candidate.row.id,
      itemId,
      channelId: channel.id,
      language: channel.language,
      sourceUrl: candidate.item.sourceUrl,
      captionShort: translation.captionShort,
      captionFull: translation.captionFull,
      hashtags: translation.hashtags,
      method: mediaRes.method,
      mediaUrls: mediaRes.mediaUrls,
      thumbnailUrls: mediaRes.thumbnailUrls,
      mediaTypes,
      scheduledAt,
    });

    if (inserted) {
      candidateQueued++;
      await recordCandidateItemEvent(env, candidate.row, itemId, candidate.item, 'queue_created', null, ai, { channelId: channel.id, language: channel.language, scheduledAt: rule.scheduledAt });
      // Now (and only now) this story_key truly reached the queue → record it so
      // storyKeySeenInWindow (which matches queued/published) can de-dup later.
      if (ai.storyKey && isStoryIntelligenceEnabled(env)) {
        await recordStoryEvent(env, {
          categoryId: candidate.row.category_id,
          channelId: channel.id,
          storyKey: ai.storyKey,
          fields: ai.storyFields ?? null,
          topicFingerprint: ai.topicFingerprint,
          sourceId: candidate.row.source_id ?? null,
          sourceAccount: candidate.item.sourceAccount ?? null,
          discoveryItemId: itemId,
          candidateId: candidate.row.id,
          status: 'queued',
        });
      }
    }
  }

  // PATCH D: if nothing reached the queue but at least one channel was blocked
  // purely by a missing translation, mark needs_translation so the next backlog
  // drain retries translation (instead of stranding it as ai_selected forever).
  // candidate-queue's fetch/claim/fail/stale all recognise needs_translation.
  const finalCandidateStatus: AICandidateStatus = candidateQueued > 0
    ? 'queued'
    : (translationMissingCount > 0 ? 'needs_translation' : 'ai_selected');
  // v4: record WHY on needs_translation so diagnosis doesn't require digging
  // through run_item_events. enabledChannelCount-translationMissingCount tells
  // us how many channels were blocked by OTHER reasons (rule gate, caps).
  await updateCandidateStatus(
    env,
    candidate.row.id,
    finalCandidateStatus,
    finalCandidateStatus === 'needs_translation'
      ? { lastError: `translation_missing:${translationMissingCount}/${enabledChannelCount}` }
      : {},
  );
  return { selected: 1, rejected: 0, queued: candidateQueued };
}

function parseCandidateRow(row: AICandidateRow): { item: NormalizedItem; keys: string[] } | null {
  try {
    const item = JSON.parse(row.normalized_item_json) as NormalizedItem;
    const keys = JSON.parse(row.dedupe_keys_json) as string[];
    if (!item || !item.sourceUrl || !item.postId || !Array.isArray(keys)) return null;
    return { item, keys };
  } catch {
    return null;
  }
}

async function checkScoringBudgetForBacklog(env: Env, callBonus = 0): Promise<ScoringBudgetSnapshot> {
  const baseMaxCalls = Math.max(0, parseInt(env.AI_MAX_CALLS_PER_DAY || '0', 10) || 0);
  // Phase 6F: while starving, the controller may grant a temporary call bonus.
  const maxCalls = baseMaxCalls > 0 ? baseMaxCalls + Math.max(0, Math.floor(callBonus)) : baseMaxCalls;
  const tokenBudget = Math.max(0, parseInt(env.AI_DAILY_TOKEN_BUDGET || '0', 10) || 0);
  const fallback: ScoringBudgetSnapshot = { allowed: true, callsToday: 0, tokensToday: 0, maxCalls, tokenBudget };
  if (!env.DB || (maxCalls === 0 && tokenBudget === 0)) return fallback;

  try {
    const row = await env.DB.prepare(`
      SELECT COUNT(*) as calls, COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
      FROM ai_usage
      WHERE provider='anthropic'
        AND purpose='scoring'
        AND status='success'
        AND created_at > datetime('now','-1 day')
    `).first<{ calls: number; tokens: number }>();

    const callsToday = Number(row?.calls ?? 0);
    const tokensToday = Number(row?.tokens ?? 0);
    if (maxCalls > 0 && callsToday >= maxCalls) return { allowed: false, reason: `AI_MAX_CALLS_PER_DAY reached (${callsToday}/${maxCalls})`, callsToday, tokensToday, maxCalls, tokenBudget };
    if (tokenBudget > 0 && tokensToday >= tokenBudget) return { allowed: false, reason: `AI_DAILY_TOKEN_BUDGET reached (${tokensToday}/${tokenBudget})`, callsToday, tokensToday, maxCalls, tokenBudget };
    return { allowed: true, callsToday, tokensToday, maxCalls, tokenBudget };
  } catch (err) {
    console.warn('[BacklogDrain] Budget check skipped:', err instanceof Error ? err.message : String(err));
    return fallback;
  }
}

async function loadCategory(env: Env, id: string): Promise<CategoryRow | null> {
  return env.DB.prepare('SELECT * FROM categories WHERE id=? AND enabled=1').bind(id).first<CategoryRow>();
}

async function loadChannels(env: Env, categoryId: string): Promise<ChannelRow[]> {
  const rows = await env.DB.prepare('SELECT * FROM channels WHERE category_id=? AND enabled=1').bind(categoryId).all<ChannelRow>();
  return rows.results ?? [];
}

async function loadWhitelistedAccounts(env: Env, categoryId: string): Promise<string[]> {
  const rows = await env.DB
    .prepare(`SELECT account_handle FROM source_accounts WHERE category_id=? AND enabled=1 AND trust_level IN ('high','medium')`)
    .bind(categoryId).all<{ account_handle: string }>();
  return (rows.results ?? []).map(x => x.account_handle);
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
    `).bind(`${itemId}_m${i}`, itemId, i, m.type, m.url,
      m.thumbnailUrl ?? null, m.width ?? null, m.height ?? null,
      m.durationSec ?? null, m.sizeMb ?? null).run();
  }
}

async function hasRecentChannelTopicMatch(
  env: Env,
  channel: ChannelRow,
  topicFingerprint: string | null | undefined
): Promise<boolean> {
  const fingerprint = String(topicFingerprint ?? '').trim().toLowerCase();

  // ns-* is a non-semantic fallback based on post_id. Do not use it for story-level dedupe.
  if (!fingerprint || fingerprint.startsWith('ns-')) return false;

  const windowHoursRaw = Number((channel as any).semantic_dedupe_window_hours);
  const windowHours = Number.isFinite(windowHoursRaw) && windowHoursRaw > 0
    ? Math.min(Math.max(windowHoursRaw, 1), 168)
    : 48;

  try {
    const row = await env.DB.prepare(`
      SELECT 1 AS found
      FROM publish_queue q
      JOIN discovery_items d ON d.id = q.item_id
      WHERE q.channel_id = ?
        AND q.status IN ('scheduled','retry','publishing','published')
        AND lower(d.topic_fingerprint) = ?
        AND COALESCE(q.published_at, q.scheduled_at) >= unixepoch('now', '-' || ? || ' hours')
      LIMIT 1
    `).bind(channel.id, fingerprint, String(windowHours)).first<{ found: number }>();

    return row?.found === 1;
  } catch (err) {
    console.warn('[BacklogDrain] recent topic dedupe skipped:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

async function hasRecentTopicMatchForAnySemanticChannel(
  env: Env,
  channels: ChannelRow[],
  topicFingerprint: string | null | undefined
): Promise<boolean> {
  const semanticChannels = channels.filter(channel => channel.enabled && channel.semantic_dedupe_enabled !== 0);
  for (const channel of semanticChannels) {
    if (await hasRecentChannelTopicMatch(env, channel, topicFingerprint)) return true;
  }
  return false;
}

async function hasRecentStoryClusterMatchForAnySemanticChannel(
  env: Env,
  channels: ChannelRow[],
  storyClusterKey: string | null,
): Promise<boolean> {
  if (!storyClusterKey) return false;
  const semanticChannels = channels.filter(channel => channel.enabled && channel.semantic_dedupe_enabled !== 0);
  for (const channel of semanticChannels) {
    if (await hasRecentStoryClusterMatch(env, channel, storyClusterKey)) return true;
  }
  return false;
}

async function hasRecentStoryClusterMatch(env: Env, channel: ChannelRow, storyClusterKey: string): Promise<boolean> {
  const windowHoursRaw = Number((channel as any).semantic_dedupe_window_hours);
  const windowHours = Number.isFinite(windowHoursRaw) && windowHoursRaw > 0
    ? Math.min(Math.max(windowHoursRaw, 1), 168)
    : 48;

  try {
    const rows = await env.DB.prepare(`
      SELECT d.topic_fingerprint, d.text AS item_text, d.source_account, q.caption_short, q.caption_full
      FROM publish_queue q
      JOIN discovery_items d ON d.id = q.item_id
      WHERE q.channel_id = ?
        AND q.status IN ('scheduled','retry','publishing','published')
        AND COALESCE(q.published_at, q.scheduled_at) >= unixepoch('now', '-' || ? || ' hours')
      ORDER BY COALESCE(q.published_at, q.scheduled_at) DESC
      LIMIT 120
    `).bind(channel.id, String(windowHours)).all<any>();

    for (const row of rows.results ?? []) {
      const existingKey = buildCryptoStoryClusterKey(
        row.topic_fingerprint,
        `${row.item_text ?? ''} ${row.caption_short ?? ''} ${row.caption_full ?? ''}`,
        row.source_account,
      );
      if (existingKey === storyClusterKey) return true;
    }
  } catch (err) {
    console.warn('[BacklogDrain] story cluster dedupe skipped:', err instanceof Error ? err.message : String(err));
  }

  return false;
}

async function getThemeCapRejectReason(env: Env, channels: ChannelRow[], themeKey: string | null): Promise<string | null> {
  const cap = getCryptoThemeDailyCap(themeKey, env); // IMPROVEMENT #4: env-overridable
  if (!themeKey || cap == null) return null;

  const semanticChannels = channels.filter(channel => channel.enabled && channel.semantic_dedupe_enabled !== 0);
  for (const channel of semanticChannels) {
    const count = await countRecentThemeMatches(env, channel, themeKey);
    if (count >= cap) return `theme_daily_cap:${themeKey}`;
  }
  return null;
}

async function countRecentThemeMatches(env: Env, channel: ChannelRow, themeKey: string): Promise<number> {
  try {
    const rows = await env.DB.prepare(`
      SELECT d.topic_fingerprint, d.text AS item_text, d.source_account, q.caption_short, q.caption_full
      FROM publish_queue q
      JOIN discovery_items d ON d.id = q.item_id
      WHERE q.channel_id = ?
        AND q.status IN ('scheduled','retry','publishing','published')
        AND COALESCE(q.published_at, q.scheduled_at) >= unixepoch('now', '-24 hours')
      ORDER BY COALESCE(q.published_at, q.scheduled_at) DESC
      LIMIT 160
    `).bind(channel.id).all<any>();

    let count = 0;
    for (const row of rows.results ?? []) {
      const existingTheme = buildCryptoThemeKey(
        row.topic_fingerprint,
        `${row.item_text ?? ''} ${row.caption_short ?? ''} ${row.caption_full ?? ''}`,
        row.source_account,
      );
      if (existingTheme === themeKey) count++;
    }
    return count;
  } catch (err) {
    console.warn('[BacklogDrain] theme cap check skipped:', err instanceof Error ? err.message : String(err));
    return 0;
  }
}

async function adjustScheduledAtForFairSourceSpacing(
  env: Env,
  channel: ChannelRow,
  sourceAccount: string,
  proposedScheduledAt: number,
): Promise<number> {
  const account = normalizeAccount(sourceAccount);
  if (!account) return proposedScheduledAt;

  const gapMinutesRaw = Number((env as any).PUBLISH_SOURCE_ACCOUNT_GAP_MINUTES);
  const gapMinutes = Number.isFinite(gapMinutesRaw) && gapMinutesRaw > 0
    ? Math.min(Math.max(Math.floor(gapMinutesRaw), 15), 360)
    : 90;
  const gapSeconds = gapMinutes * 60;
  const windowStart = proposedScheduledAt - gapSeconds;
  const windowEnd = proposedScheduledAt + gapSeconds;

  try {
    const row = await env.DB.prepare(`
      SELECT MAX(q.scheduled_at) AS latest
      FROM publish_queue q
      JOIN discovery_items d ON d.id = q.item_id
      WHERE q.channel_id = ?
        AND q.status IN ('scheduled','retry','publishing')
        AND lower(d.source_account) = ?
        AND q.scheduled_at BETWEEN ? AND ?
    `).bind(channel.id, account, windowStart, windowEnd).first<{ latest: number | null }>();

    const latest = Number(row?.latest ?? 0);
    if (Number.isFinite(latest) && latest > 0) {
      return Math.max(proposedScheduledAt, latest + gapSeconds);
    }
  } catch (err) {
    console.warn('[BacklogDrain] source spacing skipped:', err instanceof Error ? err.message : String(err));
  }

  return proposedScheduledAt;
}

async function saveQueueItem(env: Env, data: {
  candidateId: string;
  itemId: string;
  channelId: string;
  language: string;
  sourceUrl: string;
  captionShort: string;
  captionFull: string;
  hashtags: string[];
  method: string;
  mediaUrls: string[];
  thumbnailUrls: string[];
  mediaTypes: Array<'image'|'video'>;
  scheduledAt: number;
}): Promise<boolean> {
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO publish_queue
    (id,candidate_id,item_id,channel_id,language,source_url,caption_short,caption_full,hashtags,
    telegram_method,media_urls,thumbnail_urls,media_types,scheduled_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    generateId('q'), data.candidateId, data.itemId, data.channelId, data.language, data.sourceUrl,
    data.captionShort, data.captionFull, JSON.stringify(data.hashtags),
    data.method, JSON.stringify(data.mediaUrls),
    JSON.stringify(data.thumbnailUrls), JSON.stringify(data.mediaTypes),
    data.scheduledAt,
  ).run();

  return (result.meta.changes ?? 0) > 0;
}

async function recordCandidateItemEvent(
  env: Env,
  row: AICandidateRow,
  itemId: string,
  item: NormalizedItem,
  status: string,
  rejectReason: string | null,
  ai: AIGateResult,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await recordRunItemEvent(env, {
    runId: row.run_id ?? 'backlog',
    itemId,
    sourceUrl: item.sourceUrl,
    postId: item.postId,
    sourceAccount: item.sourceAccount,
    phase: 'ai_candidate_backlog',
    status,
    rejectReason,
    aiScore: ai.score,
    aiRisk: ai.riskLevel,
    mediaCount: item.media.length,
    metadata: {
      candidateId: row.id,
      riskFlags: ai.riskFlags,
      topicFingerprint: ai.topicFingerprint,
      publish: ai.publish,
      ...metadata,
    },
  });
}


async function countRecentWhaleAlertQueueItems(env: Env, channelId: string): Promise<number> {
  try {
    const row = await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM publish_queue
      WHERE channel_id = ?
        AND status IN ('scheduled','retry','publishing','published')
        AND source_url LIKE '%/whale_alert/%'
        AND COALESCE(published_at, scheduled_at) >= unixepoch('now', '-24 hours')
    `).bind(channelId).first<{ count: number }>();
    return Number(row?.count ?? 0);
  } catch (err) {
    console.warn('[BacklogDrain] whale alert daily cap check skipped:', err instanceof Error ? err.message : String(err));
    return 0;
  }
}

function normalizeAccount(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^@+/, '');
}

function isSourceDailyCapEnabled(env: Env): boolean {
  return String((env as any).PUBLISH_ENFORCE_SOURCE_DAILY_CAP_ENABLED ?? '').toLowerCase() === 'true';
}

/**
 * Phase 6I: count publish_queue items (scheduled/retry/publishing/published)
 * for a given source account on the current local day. publish_queue has no
 * source_account column, so we join discovery_items via item_id (same join the
 * operator's distribution query uses). Null/error-safe.
 */
async function countTodaysQueueItemsForSource(
  env: Env,
  channelId: string,
  sourceAccount: string,
): Promise<number> {
  const account = normalizeAccount(sourceAccount);
  if (!account) return 0;
  try {
    // Local-day boundary: compute "start of today" in the channel timezone by
    // offsetting from UTC midnight is fragile; instead use a rolling 24h window
    // which is what the whale cap uses and is robust across DST/timezones.
    const row = await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM publish_queue q
      JOIN discovery_items d ON d.id = q.item_id
      WHERE q.channel_id = ?
        AND q.status IN ('scheduled','retry','publishing','published')
        AND LOWER(REPLACE(d.source_account, '@', '')) = ?
        AND COALESCE(q.published_at, q.scheduled_at) >= unixepoch('now', '-24 hours')
    `).bind(channelId, account).first<{ count: number }>();
    return Number(row?.count ?? 0);
  } catch (err) {
    console.warn('[BacklogDrain] source daily cap check skipped:', err instanceof Error ? err.message : String(err));
    return 0;
  }
}

function channelTranslationKey(channelId: string): string {
  return `channel:${channelId}`;
}

function itemIdForCandidate(candidateId: string): string {
  return `item_${candidateId}`.slice(0, 120);
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
