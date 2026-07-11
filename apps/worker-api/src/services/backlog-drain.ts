import type { Env, AICandidateRow, AICandidateStatus, AIGateResult, CategoryRow, ChannelRow, NormalizedItem } from '../types';
import { attachTranslations, hasMustCoverCryptoAsset, runAIGate, scoreItems } from './ai-gate';
import { recordDedupeKeys } from './dedupe';
import { resolveMedia, extractMediaTypes } from './media-resolver';
import { runRuleGate } from './rule-gate';
import { recordRunEvent, recordRunItemEvent } from './run-events';
import {
  claimCandidateBatch,
  failMaxAttemptPendingCandidates,
  fetchPendingCandidates,
  hasPendingCandidatesForPlatform,
  getCandidateBacklogDrainLimit,
  getCandidateDrainPlatformAllowlist,
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
import { getQueuePolicyDecision, isQueuePolicyEnforcementEnabled, isSourceBlockedByPolicy } from './queue-policy';
import { runDuplicateAiJudgeForSurvivors } from './duplicate-ai-judge';
import { enrichAndBriefRssSurvivors, getRssBriefBudgetState } from './rss-brief';
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
  /** Budget STATE: the RSS brief daily budget is spent (informational; true even
   *  when there were no RSS candidates to defer). */
  rssBudgetExhausted?: boolean;
  /** ACTION: at least one real RSS candidate was actually set aside this run
   *  because the brief budget was spent. Distinct from `rssBudgetExhausted` so a
   *  budget-spent tick with no RSS work does not emit a false deferral signal. */
  rssDeferredThisRun?: boolean;
  /** Platforms actually deferred this run (only set when something was deferred). */
  deferredPlatforms?: string[];
  /** Benign, non-failing notices (e.g. a platform deferral) — NOT `error`. */
  warnings?: string[];
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

  let queuePolicy: Awaited<ReturnType<typeof getQueuePolicyDecision>> | null = null;
  if (isQueuePolicyEnforcementEnabled(env)) {
    const policyChannelId = String((env as any).QUEUE_HEALTH_CHANNEL_ID ?? 'crypto_fa_pilot');
    const policyChannel = await env.DB.prepare(`
      SELECT *
      FROM channels
      WHERE id = ?
      LIMIT 1
    `).bind(policyChannelId).first<ChannelRow>();

    if (policyChannel) {
      queuePolicy = await getQueuePolicyDecision(env, policyChannel);

      if (!queuePolicy.shouldRunAi) {
        const reason = `queue_policy_${queuePolicy.mode}`;
        result.skipped = true;
        result.reason = reason;
        result.warnings = [
          ...(result.warnings ?? []),
          `scheduled_next_24h:${queuePolicy.scheduledNext24h}`,
          `soft_brake_at:${queuePolicy.softBrakeAt}`,
          `hard_brake_at:${queuePolicy.hardBrakeAt}`,
        ];

        await recordRunEvent(env, {
          runId: 'backlog_drain',
          eventType: 'candidate.batch.queue_policy_stopped',
          phase: 'ai_candidate_backlog',
          severity: 'info',
          message: reason,
          categoryId: options.categoryId,
          metadata: { queuePolicy },
        });

        return result;
      }
    }
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

  const platformAllowlist = getCandidateDrainPlatformAllowlist(env);
  const rssDrainAllowed = platformAllowlist.length === 0 || platformAllowlist.includes('rss');

  // RSS brief budget gating. Disabled when the drain platform allowlist excludes
  // RSS. For the current crypto production path, X/Apify is the only active source
  // we want spending scoring/brief budget.
  let rssBudgetExhausted = rssDrainAllowed ? (await getRssBriefBudgetState(env)).exhausted : false;
  let rssDeferredThisRun = false;
  const rssDeferralWarnings = new Set<string>();
  if (rssDrainAllowed && rssBudgetExhausted) {
    rssDeferredThisRun = await hasPendingCandidatesForPlatform(env, 'rss', options.categoryId);
    if (rssDeferredThisRun) rssDeferralWarnings.add('rss_brief_daily_cap');
  }

  for (let batchNo = 0; batchNo < maxBatches && result.candidatesPulled < drainLimit; batchNo++) {
    const remaining = drainLimit - result.candidatesPulled;
    const fairPickerEnabled = isFairSourcePickerEnabled(env);
    const poolLimit = fairPickerEnabled
      ? Math.min(Math.max(batchSize * getFairSourcePickerPoolMultiplier(env), batchSize), 200)
      : Math.min(batchSize, remaining);
    const rawPendingPool = await fetchPendingCandidates(
      env,
      poolLimit,
      options.categoryId,
      rssBudgetExhausted ? 'rss' : undefined,
      platformAllowlist,
    );
    if (rawPendingPool.length === 0) break;

    let pendingPool = rawPendingPool;
    if (queuePolicy) {
      const beforePolicy = pendingPool.length;
      pendingPool = pendingPool.filter(candidate => !isSourceBlockedByPolicy(queuePolicy!, candidate.source_account));
      const filteredByPolicy = beforePolicy - pendingPool.length;

      if (filteredByPolicy > 0) {
        result.warnings = [
          ...(result.warnings ?? []),
          `queue_policy_source_filtered:${filteredByPolicy}`,
        ];
      }

      if (pendingPool.length === 0) {
        await recordRunEvent(env, {
          runId: rawPendingPool[0]?.run_id ?? 'backlog_drain',
          eventType: 'candidate.batch.queue_policy_sources_blocked',
          phase: 'ai_candidate_backlog',
          severity: 'info',
          message: 'all fetched candidates belong to policy-blocked sources',
          categoryId: options.categoryId,
          metadata: {
            filteredByPolicy,
            sourcePolicy: queuePolicy.sourcePolicy,
          },
        });
        break;
      }
    }

    const selection = selectCandidateBatchForScoring(pendingPool, Math.min(batchSize, remaining), fairPickerEnabled);
    let pending = selection.selected;
    if (pending.length === 0) break;

    // Partial-budget RSS trim: only when the selected batch actually carries RSS.
    // Re-read the brief budget (cheap COUNT) so RSS claimed ACROSS batches in this
    // tick never exceeds what brief can serve. If it just got exhausted, drop RSS
    // from this batch and continue (next fetch excludes RSS at the SQL level).
    if (rssDrainAllowed && !rssBudgetExhausted && pending.some(c => c.platform === 'rss')) {
      const briefState = await getRssBriefBudgetState(env);
      let trimmedRssThisBatch = false;

      if (briefState.exhausted) {
        rssBudgetExhausted = true;
        trimmedRssThisBatch = pending.some(c => c.platform === 'rss');
        pending = pending.filter(c => c.platform !== 'rss');
        if (trimmedRssThisBatch) rssDeferralWarnings.add('rss_brief_daily_cap');
      } else if (Number.isFinite(briefState.remaining)) {
        const rssBefore = pending.filter(c => c.platform === 'rss').length;
        let allow = briefState.remaining;
        pending = pending.filter(c => c.platform !== 'rss' || allow-- > 0);
        const rssAfter = pending.filter(c => c.platform === 'rss').length;
        trimmedRssThisBatch = rssBefore > rssAfter;
        if (trimmedRssThisBatch) rssDeferralWarnings.add('rss_brief_capacity_limited');
      }

      if (trimmedRssThisBatch) {
        rssDeferredThisRun = true;
        const targetSize = Math.min(batchSize, remaining);
        if (pending.length < targetSize) {
          const usedIds = new Set(pending.map(c => c.id));
          const refillPool = await fetchPendingCandidates(
            env,
            Math.max(targetSize * 2, targetSize),
            options.categoryId,
            'rss',
            platformAllowlist,
          );
          const refillSelection = selectCandidateBatchForScoring(
            refillPool.filter(c => !usedIds.has(c.id)),
            targetSize - pending.length,
            fairPickerEnabled,
          );
          pending = [...pending, ...refillSelection.selected];
        }
      }

      if (pending.length === 0) continue;
    }
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
    // RSS brief cap hit mid-tick (safety net; the trim above usually prevents it):
    // defer RSS for the rest of this tick but keep draining non-RSS. Not a drain
    // failure — recorded as a warning, not `error`.
    if (batchResult.rssBudgetExhausted) {
      rssBudgetExhausted = true;
      rssDeferredThisRun = true;
      rssDeferralWarnings.add('rss_brief_daily_cap');
    }
    if (batchResult.stoppedByBudget) {
      result.stoppedByBudget = true;
      result.error = batchResult.error;
      break;
    }
  }

  // Budget STATE is always surfaced; the deferral ACTION (warnings/deferredPlatforms)
  // only when real RSS work was actually set aside — so a budget-spent tick with no
  // RSS candidates doesn't read as a failure or a noisy deferral.
  if (rssBudgetExhausted) result.rssBudgetExhausted = true;
  if (rssDeferredThisRun) {
    result.rssDeferredThisRun = true;
    result.deferredPlatforms = ['rss'];
    const warnings = Array.from(rssDeferralWarnings);
    if (warnings.length > 0) result.warnings = [...(result.warnings ?? []), ...warnings];
  }

  return result;
}


export interface RepairCapBlockedSelectedOptions {
  categoryId?: string;
  limit?: number;
  dryRun?: boolean;
  sourceIds?: string[];
}

export async function repairCapBlockedSelectedCandidates(
  env: Env,
  options: RepairCapBlockedSelectedOptions = {},
): Promise<{
  ok: boolean;
  dryRun: boolean;
  categoryId: string;
  sourceIds: string[];
  found: number;
  translated: number;
  queued: number;
  notQueued: number;
  failed: number;
  candidates: Array<{ id: string; sourceId: string | null; sourceAccount: string | null; sourceUrl: string; score: number | null }>;
  errors: Array<{ id: string; error: string }>;
}> {
  const categoryId = options.categoryId ?? 'crypto';
  const defaultSourceIds = [
    'crypto_v2_news_a',
    'crypto_v2_news_b',
    'crypto_v2_market',
    'crypto_v2_analysts',
  ];
  const sourceIds = (options.sourceIds && options.sourceIds.length > 0 ? options.sourceIds : defaultSourceIds)
    .map(x => String(x ?? '').trim())
    .filter(x => /^[\w-]{1,64}$/.test(x));

  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 20), 100));
  const dryRun = options.dryRun !== false;
  const placeholders = sourceIds.map(() => '?').join(',');

  const empty = {
    ok: true,
    dryRun,
    categoryId,
    sourceIds,
    found: 0,
    translated: 0,
    queued: 0,
    notQueued: 0,
    failed: 0,
    candidates: [] as Array<{ id: string; sourceId: string | null; sourceAccount: string | null; sourceUrl: string; score: number | null }>,
    errors: [] as Array<{ id: string; error: string }>,
  };

  if (sourceIds.length === 0) return { ...empty, ok: false };

  const category = await loadCategory(env, categoryId);
  if (!category) {
    return { ...empty, ok: false, errors: [{ id: 'category', error: 'category_not_found' }] };
  }

  const channels = await loadChannels(env, categoryId);
  if (channels.length === 0) {
    return { ...empty, ok: false, errors: [{ id: 'channels', error: 'no_enabled_channels' }] };
  }

  const rows = await env.DB.prepare(`
    SELECT
      c.*,
      e.ai_score AS repair_ai_score,
      e.ai_risk AS repair_ai_risk,
      e.metadata_json AS repair_metadata_json,
      e.created_at AS repair_blocked_at
    FROM ai_candidate_queue c
    JOIN run_item_events e
      ON json_extract(e.metadata_json, '$.candidateId') = c.id
    WHERE c.category_id = ?
      AND c.platform = 'x'
      AND c.source_id IN (${placeholders})
      AND c.status = 'ai_selected'
      AND NOT EXISTS (
        SELECT 1
        FROM publish_queue q
        WHERE q.candidate_id = c.id
      )
      AND e.phase = 'ai_candidate_backlog'
      AND e.status = 'rule_gate_rejected'
      AND e.reject_reason = 'source_daily_cap'
      AND e.id = (
        SELECT e2.id
        FROM run_item_events e2
        WHERE json_extract(e2.metadata_json, '$.candidateId') = c.id
          AND e2.phase = 'ai_candidate_backlog'
          AND e2.status = 'rule_gate_rejected'
          AND e2.reject_reason = 'source_daily_cap'
        ORDER BY e2.created_at DESC
        LIMIT 1
      )
    ORDER BY e.ai_score DESC, e.created_at ASC
    LIMIT ?
  `).bind(categoryId, ...sourceIds, limit).all<any>();

  const candidates = rows.results ?? [];
  const result = { ...empty, found: candidates.length };

  for (const row of candidates) {
    result.candidates.push({
      id: row.id,
      sourceId: row.source_id ?? null,
      sourceAccount: row.source_account ?? null,
      sourceUrl: row.source_url,
      score: row.repair_ai_score == null ? null : Number(row.repair_ai_score),
    });
  }

  if (dryRun || candidates.length === 0) return result;

  const prepared: Array<{
    row: AICandidateRow;
    item: NormalizedItem;
    keys: string[];
    ai: AIGateResult;
  }> = [];

  for (const raw of candidates) {
    const row = raw as AICandidateRow & {
      repair_ai_score?: number | null;
      repair_ai_risk?: string | null;
      repair_metadata_json?: string | null;
    };

    const parsed = parseCandidateRow(row);
    if (!parsed) {
      result.failed++;
      result.errors.push({ id: row.id, error: 'invalid_candidate_payload' });
      continue;
    }

    let metadata: any = {};
    try {
      metadata = JSON.parse(String(row.repair_metadata_json ?? '{}'));
    } catch {
      metadata = {};
    }

    const score = Number(row.repair_ai_score ?? 0);
    const rawRisk = String(row.repair_ai_risk ?? 'medium').toLowerCase();
    const riskLevel = (rawRisk === 'low' || rawRisk === 'medium' || rawRisk === 'high') ? rawRisk : 'medium';

    const ai: AIGateResult = {
      publish: true,
      score: Number.isFinite(score) && score > 0 ? score : 75,
      riskLevel: riskLevel as any,
      riskFlags: Array.isArray(metadata.riskFlags) ? metadata.riskFlags.slice(0, 20).map(String) : [],
      topicFingerprint: String(metadata.topicFingerprint ?? '').slice(0, 240),
      publishPriority: score >= 85 ? 'breaking' : score >= 78 ? 'high' : 'normal',
      translations: {},
      storyKey: typeof metadata.storyKey === 'string' ? metadata.storyKey : null,
      storyFields: metadata.storyFields && typeof metadata.storyFields === 'object' ? metadata.storyFields : null,
    };

    prepared.push({ row, item: parsed.item, keys: parsed.keys, ai });
  }

  if (prepared.length === 0) return result;

  let translated: AIGateResult[];
  try {
    translated = await attachTranslations(
      env,
      prepared.map(x => x.item),
      prepared.map(x => x.ai),
      category,
      channels,
      prepared.map(x => ({
        sourceAccount: x.item.sourceAccount,
        sourceId: x.row.source_id ?? null,
        candidateId: x.row.id,
        discoveryItemId: itemIdForCandidate(x.row.id),
        channelId: channels[0]?.id ?? null,
      })),
    );
    result.translated = translated.length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ...result,
      ok: false,
      errors: [
        ...result.errors,
        { id: 'translation', error: msg },
      ],
    };
  }

  for (let i = 0; i < prepared.length; i++) {
    const candidate = prepared[i]!;
    const ai = translated[i] ?? candidate.ai;

    try {
      const itemId = itemIdForCandidate(candidate.row.id);

      // Lightweight paid recovery path:
      // The candidate was already Claude-selected and blocked only by the old
      // source_daily_cap. Do NOT run evaluateCandidateDb/persistCandidateDecision
      // again here; that path performs expensive duplicate/story/theme checks and
      // can exceed Worker CPU after translation. Build the queue row directly.
      await saveDiscoveryMedia(env, itemId, candidate.item);

      const mediaRes = resolveMedia(candidate.item.media, category.media_mode as any);
      const mediaTypes = extractMediaTypes(candidate.item.media, category.media_mode as any);
      const enabledChannels = channels.filter(channel => channel.enabled);

      let candidateQueued = 0;
      let missingTranslations = 0;
      let blockedByRule = 0;

      for (const channel of enabledChannels) {
        const translationKey = channelTranslationKey(channel.id);
        const translation = ai.translations[translationKey] ?? ai.translations[channel.language];

        if (!translation) {
          missingTranslations++;
          await recordCandidateItemEvent(
            env,
            candidate.row,
            itemId,
            candidate.item,
            'translation_missing',
            'repair_translation_missing',
            ai,
            { channelId: channel.id, language: channel.language, repair: 'cap_blocked_selected' },
          );
          continue;
        }

        const rule = await runRuleGate(env, ai, channel, candidate.item.mediaUrlExpiresSoon);
        if (!rule.approved || !rule.scheduledAt) {
          blockedByRule++;
          await recordCandidateItemEvent(
            env,
            candidate.row,
            itemId,
            candidate.item,
            'rule_gate_rejected',
            rule.reason ?? 'repair_rule_gate_rejected',
            ai,
            { channelId: channel.id, language: channel.language, repair: 'cap_blocked_selected' },
          );
          continue;
        }

        const scheduledAt = rule.scheduledAt;

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
          await recordCandidateItemEvent(
            env,
            candidate.row,
            itemId,
            candidate.item,
            'queue_created',
            null,
            ai,
            {
              channelId: channel.id,
              language: channel.language,
              scheduledAt,
              repair: 'cap_blocked_selected',
            },
          );
        }
      }

      if (candidateQueued > 0) {
        await updateCandidateStatus(env, candidate.row.id, 'queued', { lastError: 'repaired_from_source_daily_cap' });
        result.queued += candidateQueued;
      } else {
        result.notQueued += 1;
        await updateCandidateStatus(
          env,
          candidate.row.id,
          missingTranslations > 0 ? 'needs_translation' : 'ai_selected',
          {
            lastError: missingTranslations > 0
              ? `repair_translation_missing:${missingTranslations}/${enabledChannels.length}`
              : `repair_not_queued:${blockedByRule}/${enabledChannels.length}`,
          },
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.failed++;
      result.errors.push({ id: candidate.row.id, error: msg });
    }
  }

  return result;
}


function hasUnsafeMustCoverAiRisk(ai: AIGateResult): boolean {
  const flags = (ai.riskFlags ?? []).join(' ').toLowerCase();

  return ai.riskLevel === 'high'
    || /scam|pump|pump_and_dump|market_manipulation|financial_advice|sponsored_content|unverified_claims/.test(flags);
}

function isSafeMustCoverRssCandidate(item: NormalizedItem, ai?: AIGateResult): boolean {
  if (item.platform !== 'rss') return false;
  if (!hasMustCoverCryptoAsset(item)) return false;
  if (ai && hasUnsafeMustCoverAiRisk(ai)) return false;
  return true;
}

function shouldBypassPreAiRejectForMustCover(item: NormalizedItem, reason: string): boolean {
  if (!isSafeMustCoverRssCandidate(item)) return false;
  return !/scam|pump|promotional|campaign|marketing|non_crypto/i.test(reason);
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
    if (preAiReject && !shouldBypassPreAiRejectForMustCover(parsed.item, preAiReject)) {
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

  const weakGateOverrideEnabled = isWeakPostAiGateOverrideEnabled(env);
  const weakGateOverrideScoreMargin = getWeakPostAiGateOverrideScoreMargin(env);
  const queueStarvationSnapshot = weakGateOverrideEnabled
    ? await getPublishQueueStarvationSnapshot(env, channels)
    : emptyPublishQueueStarvationSnapshot();

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
      let rejectReason = resolveCandidateRejectReason(
        ev,
        ai,
        category,
        candidate.item,
        similarTopicRejects.has(i),
      );

      rejectReason = await maybeOverrideSoftEditorialReject(
        env,
        category,
        candidate,
        ai,
        ev,
        rejectReason,
        {
          enabled: weakGateOverrideEnabled,
          scoreMargin: weakGateOverrideScoreMargin,
          snapshot: queueStarvationSnapshot,
        },
      );

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

    let rejectReason = resolveCandidateRejectReason(
      ev,
      ai,
      category,
      candidate.item,
      similarTopicRejects.has(i),
    );

    rejectReason = await maybeOverrideSoftEditorialReject(
      env,
      category,
      candidate,
      ai,
      ev,
      rejectReason,
      {
        enabled: weakGateOverrideEnabled,
        scoreMargin: weakGateOverrideScoreMargin,
        snapshot: queueStarvationSnapshot,
      },
    );

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
      const rssBriefableIdx: number[] = [];

      // Cost guard: do not spend RSS brief tokens on items that cannot reach the
      // publish queue because of deterministic channel capacity gates.
      for (const i of rssSurvivorIdx) {
        const decision = decisions[i];
        if (!decision || decision.rejectReason !== null) continue;

        const preflightReject = await getRssBriefPreflightRejectReason(
          env,
          channels,
          decision.candidate,
          decision.ai,
        );

        if (preflightReject) {
          decision.rejectReason = preflightReject;
        } else {
          rssBriefableIdx.push(i);
        }
      }

      if (rssBriefableIdx.length > 0) {
        const items = rssBriefableIdx.map(i => prepared[i]!.item);
        const ais = rssBriefableIdx.map(i => decisions[i]!.ai);
        const labels = rssBriefableIdx.map(i => prepared[i]!.item.sourceAccount);
        try {
          const { results: briefed, failedIndexes, capDeferredIndexes } = await enrichAndBriefRssSurvivors(env, items, ais, category, channels, labels);
          rssBriefableIdx.forEach((i, k) => { decisions[i]!.ai = briefed[k]!; });

          // Per-item brief failures: release ONLY those candidates to pending and
          // drop them from this tick's decisions so they are not persisted (which
          // would record dedupe_keys and never retry). Local index k → original i.
          if (failedIndexes.length > 0) {
            const failedOriginalIdx = failedIndexes.map(k => rssBriefableIdx[k]!);
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
            const deferredOriginalIdx = capDeferredIndexes.map(k => rssBriefableIdx[k]!);
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
            rssBriefableIdx.map(i => prepared[i]!.row.id),
            `rss_brief_error: ${msg}`,
            { decrementAttempt: true },
          );
          rssBriefableIdx.forEach(i => { decisions[i] = null; });
          skipped += rssBriefableIdx.length;
        }
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
    // are not re-claimed) WITHOUT halting the non-RSS backlog. The outer loop
    // records the benign warning; this is not a drain `error`.
    rssBudgetExhausted: rssBriefCapHit,
  };
}

// ── Phase 6H helpers (shared by both paths) ───────────────────

export interface CandidateEvaluation {
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

  return {
    itemId,
    storyClusterKey,
    themeKey,
    recentTopicDuplicate,
    recentStoryClusterDuplicate,
    themeCapRejectReason,
    audienceRejectReason,
    storyKey,
    storyKeyRejectReason,
  };
}


async function getRssBriefPreflightRejectReason(
  env: Env,
  channels: ChannelRow[],
  candidate: { item: NormalizedItem; row: AICandidateRow; keys: string[] },
  ai: AIGateResult,
): Promise<string | null> {
  if (candidate.item.platform !== 'rss') return null;

  const enabledChannels = channels.filter(channel => channel.enabled);
  if (enabledChannels.length === 0) return 'rss_brief_preflight_blocked:no_enabled_channel';

  let lastReason = 'no_publish_capacity';
  const placeholder = {
    captionShort: 'RSS preflight placeholder',
    captionFull: 'RSS preflight placeholder',
    hashtags: [] as string[],
  };

  for (const channel of enabledChannels) {
    const translationKey = channelTranslationKey(channel.id);
    const probeAi: AIGateResult = {
      ...ai,
      translations: {
        ...(ai.translations ?? {}),
        [channel.language]: placeholder,
        [translationKey]: placeholder,
      },
    };

    const rule = await runRuleGate(env, probeAi, channel, candidate.item.mediaUrlExpiresSoon);
    if (!rule.approved || !rule.scheduledAt) {
      lastReason = rule.reason ? `rule_gate:${rule.reason}` : 'rule_gate_rejected';
      continue;
    }

    if (normalizeAccount(candidate.item.sourceAccount) === 'whale_alert') {
      const alreadyQueued = await countRecentWhaleAlertQueueItems(env, channel.id);
      if (alreadyQueued >= 2) {
        lastReason = 'whale_alert_daily_cap';
        continue;
      }
    }

    if (isSourceDailyCapEnabled(env) && channel.max_posts_per_source_per_day != null) {
      const cap = Number(channel.max_posts_per_source_per_day);
      if (Number.isFinite(cap) && cap > 0) {
        const alreadyFromSource = await countTodaysQueueItemsForSource(env, channel.id, candidate.item.sourceAccount);
        if (alreadyFromSource >= cap) {
          lastReason = 'source_daily_cap';
          continue;
        }
      }
    }

    return null;
  }

  return `rss_brief_preflight_blocked:${lastReason}`;
}

function isWeakPostAiGateOverrideEnabled(env: Env): boolean {
  return String(env.WEAK_POST_AI_GATE_OVERRIDE_ENABLED ?? '').toLowerCase() === 'true';
}

function getWeakPostAiGateOverrideScoreMargin(env: Env): number {
  const raw = Number(env.WEAK_POST_AI_GATE_OVERRIDE_SCORE_MARGIN ?? 5);
  return Number.isFinite(raw)
    ? Math.max(0, Math.min(30, Math.floor(raw)))
    : 5;
}

export interface PublishQueueStarvationSnapshot {
  allEnabledChannelsStarving: boolean;
  minScheduledNext6h: number;
  channels: Array<{
    channelId: string;
    scheduledNext6h: number;
    starving: boolean;
  }>;
}

function emptyPublishQueueStarvationSnapshot(): PublishQueueStarvationSnapshot {
  return {
    allEnabledChannelsStarving: false,
    minScheduledNext6h: 0,
    channels: [],
  };
}

async function getPublishQueueStarvationSnapshot(
  env: Env,
  channels: ChannelRow[],
): Promise<PublishQueueStarvationSnapshot> {
  if (!env.DB) return emptyPublishQueueStarvationSnapshot();

  const enabledChannels = channels.filter(channel => channel.enabled);
  if (enabledChannels.length === 0) return emptyPublishQueueStarvationSnapshot();

  const parsedFloor = parseInt(
    String(env.QUEUE_HEALTH_MIN_SCHEDULED_NEXT_6H ?? '4'),
    10,
  );
  const minScheduledNext6h = Number.isFinite(parsedFloor)
    ? Math.max(1, Math.min(100, parsedFloor))
    : 4;

  const snapshots: PublishQueueStarvationSnapshot['channels'] = [];

  for (const channel of enabledChannels) {
    const row = await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM publish_queue
      WHERE channel_id = ?
        AND status IN ('scheduled','retry')
        AND scheduled_at >= unixepoch('now')
        AND scheduled_at <= unixepoch('now') + 6 * 3600
    `).bind(channel.id).first<{ count: number }>();

    const scheduledNext6h = Number(row?.count ?? 0);
    snapshots.push({
      channelId: channel.id,
      scheduledNext6h,
      starving: scheduledNext6h < minScheduledNext6h,
    });
  }

  return {
    // The decision is made before per-channel persistence. Therefore the safe,
    // channel-agnostic rule is to override only when EVERY target channel needs
    // inventory. One starving channel must not weaken gates for healthy channels.
    allEnabledChannelsStarving:
      snapshots.length > 0 && snapshots.every(channel => channel.starving),
    minScheduledNext6h,
    channels: snapshots,
  };
}

function hasHardQualityRisk(ai: AIGateResult): boolean {
  const flags = (ai.riskFlags ?? []).map(flag => String(flag).toLowerCase());

  return flags.some(flag =>
    flag.includes('financial_advice')
    || flag.includes('market_prediction')
    || flag.includes('pump')
    || flag.includes('promotional')
    || flag.includes('scam')
    || flag.includes('misleading')
    || flag.includes('low_substance')
    || flag.includes('engagement_bait')
    || flag.includes('unverified')
    || flag.includes('rumor')
    || flag.includes('limited_text_context')
  );
}

/**
 * Editorial capacity gates are not duplicate evidence.
 *
 * This classification is intentionally generic:
 * - any configured theme daily cap
 * - any audience/profile policy whose meaning is "requires material impact"
 *
 * Semantic, topic, story-key and final-publish duplicate reasons are NEVER soft.
 */
export function isSoftEditorialGateReject(reason: string | null): boolean {
  const normalized = String(reason ?? '').trim().toLowerCase();
  if (!normalized) return false;

  return normalized.startsWith('theme_daily_cap:')
    || normalized.endsWith('_requires_material_impact');
}

export function shouldOverrideSoftEditorialReject(args: {
  enabled: boolean;
  rejectReason: string | null;
  ai: Pick<AIGateResult, 'publish' | 'score' | 'riskLevel' | 'riskFlags'>;
  queueStarving: boolean;
  categoryScoreThreshold: number;
  scoreMargin: number;
}): boolean {
  if (!args.enabled) return false;
  if (!args.queueStarving) return false;
  if (!isSoftEditorialGateReject(args.rejectReason)) return false;

  if (args.ai.publish !== true) return false;
  if (args.ai.riskLevel === 'high') return false;
  if (hasHardQualityRisk(args.ai as AIGateResult)) return false;

  const score = Number(args.ai.score);
  const threshold = Number(args.categoryScoreThreshold);
  const margin = Math.max(0, Number(args.scoreMargin) || 0);

  if (!Number.isFinite(score) || !Number.isFinite(threshold)) return false;
  if (score < threshold + margin) return false;

  return true;
}

async function maybeOverrideSoftEditorialReject(
  env: Env,
  category: CategoryRow,
  candidate: { item: NormalizedItem; row: AICandidateRow; keys: string[] },
  ai: AIGateResult,
  ev: CandidateEvaluation,
  rejectReason: string | null,
  policy: {
    enabled: boolean;
    scoreMargin: number;
    snapshot: PublishQueueStarvationSnapshot;
  },
): Promise<string | null> {
  const shouldOverride = shouldOverrideSoftEditorialReject({
    enabled: policy.enabled,
    rejectReason,
    ai,
    queueStarving: policy.snapshot.allEnabledChannelsStarving,
    categoryScoreThreshold: Number(category.score_threshold),
    scoreMargin: policy.scoreMargin,
  });

  if (!shouldOverride) return rejectReason;

  await recordCandidateItemEvent(
    env,
    candidate.row,
    itemIdForCandidate(candidate.row.id),
    candidate.item,
    'weak_post_ai_gate_overridden',
    rejectReason,
    ai,
    {
      originalRejectReason: rejectReason,
      overrideReason: 'all_target_queues_starving_strong_ai_candidate',
      categoryScoreThreshold: Number(category.score_threshold),
      scoreMargin: policy.scoreMargin,
      requiredScore: Number(category.score_threshold) + policy.scoreMargin,
      queueStarvationSnapshot: policy.snapshot,
      storyKey: ev.storyKey,
      storyKeyRejectReason: ev.storyKeyRejectReason,
      storyClusterKey: ev.storyClusterKey,
      themeKey: ev.themeKey,
      themeCapRejectReason: ev.themeCapRejectReason,
      audienceRejectReason: ev.audienceRejectReason,
    },
  );

  return null;
}


export function resolveCandidateRejectReason(
  ev: CandidateEvaluation,
  ai: AIGateResult,
  category: CategoryRow,
  item: NormalizedItem,
  similarTopicRejected: boolean,
): string | null {
  const mustCover = isSafeMustCoverRssCandidate(item, ai);
  const themeReject = mustCover ? null : ev.themeCapRejectReason;
  const audienceReject = mustCover ? null : ev.audienceRejectReason;

  // Hard deterministic duplicate checks must never be hidden behind a soft
  // editorial gate. This also prevents starvation overrides from rescuing an
  // exact same-batch duplicate.
  if (ev.recentTopicDuplicate) return 'similar_topic_recent_channel';
  if (similarTopicRejected) return 'similar_topic_in_run';

  // Quality eligibility must be decided before theme/audience capacity gates.
  // Otherwise a theme cap can mask below_threshold/high_risk/media rules.
  const hardItemReject = getItemRejectReason(
    ai,
    category,
    item,
    false,
  );
  if (hardItemReject) return hardItemReject;

  // Story-key and semantic story matches remain hard duplicate evidence.
  // Queue starvation is deliberately not allowed to override them.
  if (ev.storyKeyRejectReason) return ev.storyKeyRejectReason;

  // Story clusters remain advisory-only and are intentionally absent here.
  return themeReject
    ?? audienceReject
    ?? null;
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
    storyKey: ai.storyKey ?? null,
    storyKeyRejectReason: ev.storyKeyRejectReason,
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
  let finalDuplicateBlockedCount = 0;
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

    const finalDuplicate = await findFinalPublishDuplicate(env, {
      channel,
      item: candidate.item,
      ai,
      captionShort: translation.captionShort,
      captionFull: translation.captionFull,
    });

    if (finalDuplicate) {
      finalDuplicateBlockedCount++;
      await recordCandidateItemEvent(
        env,
        candidate.row,
        itemId,
        candidate.item,
        'ai_rejected',
        'final_publish_duplicate_guard',
        {
          ...ai,
          riskFlags: Array.from(new Set([
            ...(ai.riskFlags ?? []),
            'final_publish_duplicate_guard',
            `final_duplicate_reason:${finalDuplicate.reason}`,
          ])).slice(0, 10),
        },
        {
          channelId: channel.id,
          language: channel.language,
          finalDuplicate,
        },
      );
      continue;
    }

    const scheduledAt = rule.scheduledAt;
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
  const blockedOnlyByFinalDuplicate = candidateQueued === 0
    && finalDuplicateBlockedCount > 0
    && translationMissingCount === 0;

  const finalCandidateStatus: AICandidateStatus = candidateQueued > 0
    ? 'queued'
    : (translationMissingCount > 0
      ? 'needs_translation'
      : (blockedOnlyByFinalDuplicate ? 'ai_rejected' : 'ai_selected'));

  // v4: record WHY on needs_translation so diagnosis doesn't require digging
  // through run_item_events. enabledChannelCount-translationMissingCount tells
  // us how many channels were blocked by OTHER reasons (rule gate, caps).
  await updateCandidateStatus(
    env,
    candidate.row.id,
    finalCandidateStatus,
    finalCandidateStatus === 'needs_translation'
      ? { lastError: `translation_missing:${translationMissingCount}/${enabledChannelCount}` }
      : (blockedOnlyByFinalDuplicate
        ? { lastError: `final_publish_duplicate_guard:${finalDuplicateBlockedCount}/${enabledChannelCount}` }
        : {}),
  );

  return {
    selected: blockedOnlyByFinalDuplicate ? 0 : 1,
    rejected: blockedOnlyByFinalDuplicate ? 1 : 0,
    queued: candidateQueued,
  };
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

interface FinalPublishDuplicateGuardInput {
  channel: ChannelRow;
  item: NormalizedItem;
  ai: AIGateResult;
  captionShort: string;
  captionFull: string;
}

interface FinalPublishDuplicateMatch {
  reason: string;
  matchedQueueId: string;
  matchedSourceUrl: string | null;
  matchedSourceAccount: string | null;
  matchedTopicFingerprint: string | null;
  matchedStoryKey: string | null;
  score: number;
}

function isFinalPublishDuplicateGuardEnabled(env: Env): boolean {
  return String((env as any).FINAL_PUBLISH_DUPLICATE_GUARD_ENABLED ?? '').toLowerCase() === 'true';
}

function getFinalPublishDuplicateGuardWindowHours(env: Env): number {
  const raw = Number((env as any).FINAL_PUBLISH_DUPLICATE_GUARD_WINDOW_HOURS ?? (env as any).STORY_INTELLIGENCE_WINDOW_HOURS ?? 72);
  return Number.isFinite(raw) ? Math.max(6, Math.min(168, Math.floor(raw))) : 72;
}

function normalizeFinalDupeText(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&amp;/g, ' and ')
    .replace(/[۰-۹٠-٩]/g, ch => {
      const map: Record<string, string> = {
        '۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9',
        '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9',
      };
      return map[ch] ?? ch;
    })
    .replace(/[ي]/g, 'ی')
    .replace(/[ك]/g, 'ک')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\u0600-\u06ff.%$]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const FINAL_DUPE_STOP_TERMS = new Set([
  'the','and','for','with','that','this','from','into','onto','over','under','more','less',
  'new','now','latest','just','breaking','bullish','watch','whale','crypto','market','markets',
  'report','reports','says','said','according','per','data','today','yesterday','tomorrow',
  'chain','network','protocol','ecosystem','price','prices','token','tokens','coin','coins',
  'big','insight','via','daily','weekly','monthly','year','years','month','months','june','july',
  '2024','2025','2026','2027','million','billion','thousand','dollar','dollars','usd',
  'institutional','corporate','analysis','activity','commentary','structure','product','infrastructure',
  'signal','metric','metrics','finance','supply','framework','wallet','performance','strategy',
  'خبر','جدید','بازار','رمزارز','کریپتو','گزارش','طبق','اعلام','امروز','دیروز','فردا',
  'این','آن','برای','از','به','در','با','که','شد','می‌شود','کرد','کرده','است','هست',
  'است.','های','نشان','دهنده','کوین','دلار','دارایی','شده','بیت','خود','میلیون',
  'شرکت','سرمایه','کند','کند.','تواند','اقدام','گذاری','صرافی','مالی','سال','قانون',
  'داده','رمزارزها','بیش','شبکه','توسط','استفاده','میلیارد','اتریوم','کاربران',
  'آمریکا','دهد','دهد.','رمزارزی','حدود','شود','شود.','پیش','ارزش','قابل',
  'تراکنش','بلاکچین','حجم','بازارهای','دلاری','خدمات','باشد','باشد.','پلتفرم',
  'حال','بین','فعالیت','حوزه','بیشتر','توکن','راه','رشد','دارد','دارد.','هدف',
  'خواهد','معاملات','ماه','ارائه','ثبت','گذاران','قیمت','درصد','سهام','روی',
  'گذشته','روند','قرار','دلیل','دریافت','معامله',
]);

const FINAL_DUPE_GENERIC_ASSET_TERMS = new Set([
  'bitcoin','btc','ethereum','eth','solana','sol','xrp','bnb','trx','doge','ada','usdt','usdc',
]);

const FINAL_DUPE_ACTION_TERMS = new Set([
  'buy','buys','bought','purchase','purchases','purchased','sell','sells','sold','selling',
  'acquire','acquires','acquired','acquisition','merge','merger','partnership',
  'launch','launches','launched','listing','lists','listed','delist','delists','delisted','delisting',
  'approve','approves','approved','approval','authorize','authorizes','authorized',
  'secure','secures','secured','receive','receives','received',
  'reject','rejects','rejected','file','files','filed','filing','pass','passes','passed',
  'defend','defends','defended','veto','vetoes','vetoed',
  'regulation','regulatory','law','act','bill','license','licence','licensing',
  'sanction','sanctions','enforce','enforces','enforced','enforcement',
  'lawsuit','litigation','settlement','fraud',
  'hack','exploit','exploited','drain','drained','attack','bug','audit','security','phishing',
  'volume','tvl','inflow','inflows','outflow','outflows','flow','flows','liquidity',
  'treasury','reserve','reserves','holdings','custody',
  'funding','raise','raises','raised','investment','invests','invested',
  'upgrade','upgrades','upgraded','governance','vote','votes',
  'flip','flips','flipped','overtake','overtakes','overtook','exceed','exceeds','exceeded',
  'surge','surges','surged','record','records','recorded','milestone',
  'drop','drops','dropped','decline','declines','declined','rise','rises','rose',
  'increase','increases','increased','decrease','decreases','decreased',
  'crash','crashes','crashed','plunge','plunges','plunged',
  'migrate','migrates','migrated','migration','integrate','integrates','integrated','integration',
  'bridge','bridges','bridged','closure','close','closes','closed',
  'stake','stakes','staked','staking','include','includes','included','inclusion',
  'terminate','terminates','terminated','termination','movement','move','moves','moved',
  'خرید','فروش','تصاحب','ادغام','همکاری','راه‌اندازی','مجوز','قانون','تحریم','هک',
  'حمله','آسیب‌پذیری','حجم','ذخایر','دارایی','سرمایه‌گذاری','ارتقا','دادگاه',
  'عبور','پیشی','رکورد','افزایش','کاهش','سقوط','تصویب','رد','دریافت','مهاجرت',
  'یکپارچه‌سازی','حذف','تعلیق','شکایت','تسویه','کلاهبرداری','مجوزدهی','اجرایی',
]);

function canonicalFinalDupeToken(raw: unknown): string | null {
  const token = String(raw ?? '')
    .toLowerCase()
    .replace(/^[$#]+/, '')
    .replace(/&amp;/g, 'and')
    .replace(/[^a-z0-9\u0600-\u06ff.%]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!token || token.length < 3) return null;

  const aliases: Record<string, string> = {
    bit_coin: 'bitcoin',
    btc: 'bitcoin',
    ether: 'ethereum',
    eth: 'ethereum',
    stable_coin: 'stablecoin',
    stablecoins: 'stablecoin',
    etfs: 'etf',
    dexes: 'dex',
    companies: 'company',
    corporates: 'corporate',
    regulations: 'regulation',
    sanctions: 'sanction',
    reserves: 'reserve',
    holdings: 'holding',
    bought: 'buy',
    buys: 'buy',
    purchased: 'purchase',
    purchases: 'purchase',
    sold: 'sell',
    sells: 'sell',
    selling: 'sell',
    acquired: 'acquire',
    acquires: 'acquire',
    launches: 'launch',
    launched: 'launch',
    approved: 'approval',
    approves: 'approval',
    filings: 'filing',
  };

  return aliases[token] ?? token;
}

function finalDupeTokens(value: unknown): Set<string> {
  const text = normalizeFinalDupeText(value);
  const out = new Set<string>();

  for (const raw of text.split(' ')) {
    const token = canonicalFinalDupeToken(raw);
    if (!token) continue;
    if (FINAL_DUPE_STOP_TERMS.has(token)) continue;
    out.add(token);

    if (token.includes('_')) {
      for (const part of token.split('_')) {
        const p = canonicalFinalDupeToken(part);
        if (p && !FINAL_DUPE_STOP_TERMS.has(p)) out.add(p);
      }
    }
  }

  return out;
}

function finalDupeNumbers(value: unknown): Set<string> {
  const text = normalizeFinalDupeText(value).replace(/,/g, '');
  const out = new Set<string>();
  const re = /(?:[$]\s*)?(\d+(?:\.\d+)?)\s*(k|m|mn|b|bn|t|million|billion|thousand|trillion|%|percent|btc|eth|trx|usd|usdt|usdc)?/gi;
  const multipliers: Record<string, number> = {
    k: 1_000,
    m: 1_000_000,
    b: 1_000_000_000,
    t: 1_000_000_000_000,
  };
  const taggedUnits = new Set(['btc', 'eth', 'trx', 'usd', 'usdt', 'usdc']);
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const rawNumber = match[1];
    const n = Number(rawNumber);
    if (!Number.isFinite(n)) continue;

    let unit = String(match[2] ?? '').toLowerCase();
    if (['mn', 'million'].includes(unit)) unit = 'm';
    if (['bn', 'billion'].includes(unit)) unit = 'b';
    if (unit === 'thousand') unit = 'k';
    if (unit === 'trillion') unit = 't';
    if (unit === 'percent') unit = '%';

    if (unit === '%') {
      if (n >= 1) out.add(`${rawNumber}%`);
      continue;
    }

    const multiplier = multipliers[unit] ?? 1;
    const normalized = Math.round(n * multiplier);

    // Tiny bare numbers and standalone years are noisy in crypto headlines.
    if (!unit && normalized < 100) continue;
    if (!unit && normalized >= 1900 && normalized <= 2100) continue;

    if (normalized <= 0) continue;

    // Add a unitless normalized value so 110k and 110,000 BTC can match.
    out.add(String(normalized));

    if (taggedUnits.has(unit)) {
      out.add(`${normalized}${unit}`);
    }
  }

  return out;
}

function normalizeFinalDupeKey(value: unknown): string | null {
  const key = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!key) return null;
  if (key.startsWith('ns_') || key.startsWith('fp_') || key.startsWith('err_') || key.startsWith('budget_')) return null;
  return key;
}

function finalDupeCombinedText(args: {
  sourceText?: string | null;
  captionShort?: string | null;
  captionFull?: string | null;
  topicFingerprint?: string | null;
  storyKey?: string | null;
  eventType?: string | null;
  primaryEntities?: unknown;
}): string {
  return [
    args.sourceText,
    args.captionShort,
    args.captionFull,
    args.topicFingerprint,
    args.storyKey,
    args.eventType,
    Array.isArray(args.primaryEntities) ? args.primaryEntities.join(' ') : '',
  ].filter(Boolean).join(' ');
}

function intersectionCountSet(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

function jaccardSet(a: Set<string>, b: Set<string>): number {
  const overlap = intersectionCountSet(a, b);
  if (overlap <= 0) return 0;
  return overlap / (a.size + b.size - overlap);
}

function finalDupeSpecificAnchors(tokens: Set<string>): Set<string> {
  const out = new Set<string>();

  for (const token of tokens) {
    if (FINAL_DUPE_STOP_TERMS.has(token)) continue;
    if (FINAL_DUPE_ACTION_TERMS.has(token)) continue;
    // Generic assets like bitcoin/ethereum are too broad to be treated as
    // specific story anchors. They remain useful as tokens/numbers context,
    // but should not make unrelated BTC/ETH stories look duplicate.
    if (FINAL_DUPE_GENERIC_ASSET_TERMS.has(token)) continue;
    if (/^\d/.test(token)) continue;
    if (token.length < 4) continue;
    out.add(token);
  }

  return out;
}

function finalDupeActionTokens(tokens: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const token of tokens) {
    if (FINAL_DUPE_ACTION_TERMS.has(token)) out.add(token);
  }
  return out;
}

function buildFinalDupeSignal(args: {
  sourceUrl?: string | null;
  sourceAccount?: string | null;
  sourceText?: string | null;
  captionShort?: string | null;
  captionFull?: string | null;
  topicFingerprint?: string | null;
  storyKey?: string | null;
  storyFields?: AIGateResult['storyFields'] | null;
}) {
  const eventType = args.storyFields?.eventType ?? null;
  const combined = finalDupeCombinedText({
    sourceText: args.sourceText,
    captionShort: args.captionShort,
    captionFull: args.captionFull,
    topicFingerprint: args.topicFingerprint,
    storyKey: args.storyKey,
    eventType,
    primaryEntities: args.storyFields?.primaryEntities,
  });

  const tokens = finalDupeTokens(combined);
  const anchors = finalDupeSpecificAnchors(tokens);
  const actions = finalDupeActionTokens(tokens);
  const numbers = finalDupeNumbers(combined);

  return {
    sourceUrl: String(args.sourceUrl ?? '').trim() || null,
    sourceAccount: String(args.sourceAccount ?? '').trim() || null,
    topicKey: normalizeFinalDupeKey(args.topicFingerprint),
    storyKey: normalizeFinalDupeKey(args.storyKey),
    storyFields: args.storyFields ?? null,
    eventType,
    topicFingerprint: args.topicFingerprint ?? null,
    text: args.sourceText ?? null,
    tokens,
    anchors,
    actions,
    numbers,
  };
}

function scoreFinalPublishDuplicate(
  current: ReturnType<typeof buildFinalDupeSignal>,
  prior: ReturnType<typeof buildFinalDupeSignal>,
  followupAllowEnabled: boolean,
): { duplicate: boolean; score: number; reason: string } {
  if (current.sourceUrl && prior.sourceUrl && current.sourceUrl === prior.sourceUrl) {
    return { duplicate: true, score: 1, reason: 'same_source_url' };
  }

  if (current.storyKey && prior.storyKey && current.storyKey === prior.storyKey) {
    if (followupAllowEnabled && isFollowUpEventType(current.eventType)) {
      return { duplicate: false, score: 0, reason: 'same_story_key_followup_allowed' };
    }
    return { duplicate: true, score: 0.98, reason: 'same_story_key' };
  }

  if (current.topicKey && prior.topicKey && current.topicKey === prior.topicKey) {
    return { duplicate: true, score: 0.96, reason: 'same_topic_fingerprint' };
  }

  if (shouldRejectBySemanticStorySimilarity({
    rejectEnabled: true,
    current: {
      storyKey: current.storyKey,
      fields: current.storyFields,
      topicFingerprint: current.topicFingerprint,
      eventType: current.eventType,
      text: current.text,
    },
    prior: {
      storyKey: prior.storyKey,
      fields: prior.storyFields,
      topicFingerprint: prior.topicFingerprint,
      eventType: prior.eventType,
      text: prior.text,
    },
    followupAllowEnabled,
  })) {
    return { duplicate: true, score: 0.92, reason: 'semantic_story_similarity' };
  }

  // Strict generic fallback. The 7-day audit showed broad entity+number
  // matching creates false positives, so only very high-confidence paraphrases
  // are blocked here. Everything else is left to exact/story/semantic checks.
  if (followupAllowEnabled && isFollowUpEventType(current.eventType)) {
    return { duplicate: false, score: 0, reason: 'followup_allowed' };
  }

  const sharedAnchors = intersectionCountSet(current.anchors, prior.anchors);
  const sharedActions = intersectionCountSet(current.actions, prior.actions);
  const sharedNumbers = intersectionCountSet(current.numbers, prior.numbers);
  const tokenOverlap = intersectionCountSet(current.tokens, prior.tokens);
  const tokenJaccard = jaccardSet(current.tokens, prior.tokens);

  // Strong rewritten-story duplicate:
  // same specific entities + same event action + strong textual overlap.
  if (sharedAnchors >= 3 && sharedActions >= 1 && tokenOverlap >= 8 && tokenJaccard >= 0.32) {
    return { duplicate: true, score: Math.max(0.9, tokenJaccard), reason: 'strict_shared_entities_action' };
  }

  // Number-heavy story duplicate:
  // same specific entities + same material numbers + strong overlap.
  if (sharedAnchors >= 2 && sharedNumbers >= 2 && tokenOverlap >= 8 && tokenJaccard >= 0.30) {
    return { duplicate: true, score: Math.max(0.9, tokenJaccard), reason: 'strict_shared_entities_numbers' };
  }

  // One shared material number is allowed only with strong entity/action overlap.
  if (sharedAnchors >= 3 && sharedActions >= 1 && sharedNumbers >= 1 && tokenOverlap >= 9 && tokenJaccard >= 0.34) {
    return { duplicate: true, score: Math.max(0.9, tokenJaccard), reason: 'strict_entities_action_number' };
  }

  // Near-copy / heavy paraphrase duplicate.
  if (sharedAnchors >= 2 && tokenOverlap >= 16 && tokenJaccard >= 0.50) {
    return { duplicate: true, score: Math.max(0.88, tokenJaccard), reason: 'strict_near_copy_overlap' };
  }

  return { duplicate: false, score: tokenJaccard, reason: 'no_strong_match' };
}

function parseFinalDupePriorStoryFields(row: any): AIGateResult['storyFields'] | null {
  const entitiesRaw = row.primary_entities_json;
  let primaryEntities: string[] = [];

  if (entitiesRaw) {
    try {
      const parsed = JSON.parse(String(entitiesRaw));
      if (Array.isArray(parsed)) primaryEntities = parsed.map(x => String(x));
    } catch {
      primaryEntities = [];
    }
  }

  const eventType = String(row.event_type ?? '').trim();
  const canonicalDate = String(row.canonical_date ?? '').trim();

  if (primaryEntities.length === 0 && !eventType && !canonicalDate) return null;

  return {
    primaryEntities,
    eventType: eventType || 'unknown',
    canonicalDate: canonicalDate || '',
  } as AIGateResult['storyFields'];
}

async function findFinalPublishDuplicate(env: Env, input: FinalPublishDuplicateGuardInput): Promise<FinalPublishDuplicateMatch | null> {
  if (!isFinalPublishDuplicateGuardEnabled(env)) return null;

  // First rollout: X only. RSS has a different brief/copyright path and should not
  // be behavior-coupled to this X incident fix.
  if (input.item.platform !== 'x') return null;

  const channelId = input.channel.id;
  if (!channelId) return null;

  const current = buildFinalDupeSignal({
    sourceUrl: input.item.sourceUrl,
    sourceAccount: input.item.sourceAccount,
    sourceText: input.item.text,
    captionShort: input.captionShort,
    captionFull: input.captionFull,
    topicFingerprint: input.ai.topicFingerprint,
    storyKey: input.ai.storyKey ?? null,
    storyFields: input.ai.storyFields ?? null,
  });

  const windowHours = getFinalPublishDuplicateGuardWindowHours(env);
  const followupAllowEnabled = isStoryFollowupAllowEnabled(env);

  try {
    const res = await env.DB.prepare(`
      SELECT
        q.id AS queue_id,
        q.source_url AS queue_source_url,
        q.caption_short,
        q.caption_full,
        q.scheduled_at,
        q.published_at,
        d.source_account,
        d.source_url AS item_source_url,
        d.text AS source_text,
        d.topic_fingerprint,
        sie.story_key,
        sie.event_type,
        sie.canonical_date,
        sie.primary_entities_json,
        sie.topic_fingerprint AS story_topic_fingerprint
      FROM publish_queue q
      JOIN discovery_items d ON d.id = q.item_id
      LEFT JOIN story_intelligence_events sie
        ON sie.candidate_id = q.candidate_id
       AND sie.status IN ('queued','published')
      WHERE q.channel_id = ?
        AND q.status IN ('scheduled','retry','publishing','published')
        AND COALESCE(q.published_at, q.scheduled_at, 0) >= unixepoch('now') - ?
      ORDER BY COALESCE(q.published_at, q.scheduled_at, 0) DESC
      LIMIT 180
    `).bind(channelId, String(windowHours * 3600)).all<any>();

    let best: FinalPublishDuplicateMatch | null = null;

    for (const row of res.results ?? []) {
      const prior = buildFinalDupeSignal({
        sourceUrl: row.item_source_url ?? row.queue_source_url,
        sourceAccount: row.source_account,
        sourceText: row.source_text,
        captionShort: row.caption_short,
        captionFull: row.caption_full,
        topicFingerprint: row.story_topic_fingerprint ?? row.topic_fingerprint,
        storyKey: row.story_key,
        storyFields: parseFinalDupePriorStoryFields(row),
      });

      const scored = scoreFinalPublishDuplicate(current, prior, followupAllowEnabled);
      if (!scored.duplicate) continue;

      const match: FinalPublishDuplicateMatch = {
        reason: scored.reason,
        matchedQueueId: String(row.queue_id ?? ''),
        matchedSourceUrl: String(row.item_source_url ?? row.queue_source_url ?? '') || null,
        matchedSourceAccount: String(row.source_account ?? '') || null,
        matchedTopicFingerprint: String(row.story_topic_fingerprint ?? row.topic_fingerprint ?? '') || null,
        matchedStoryKey: String(row.story_key ?? '') || null,
        score: Math.round(scored.score * 1000) / 1000,
      };

      if (!best || match.score > best.score) best = match;
    }

    return best;
  } catch (err) {
    console.warn('[BacklogDrain] final publish duplicate guard skipped:', err instanceof Error ? err.message : String(err));
    return null;
  }
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
