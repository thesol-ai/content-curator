import type { Env, AICandidateRow, AIGateResult, CategoryRow, ChannelRow, NormalizedItem } from '../types';
import { runAIGate } from './ai-gate';
import { recordDedupeKeys } from './dedupe';
import { resolveMedia, extractMediaTypes } from './media-resolver';
import { runRuleGate } from './rule-gate';
import { recordRunEvent, recordRunItemEvent } from './run-events';
import {
  claimCandidateBatch,
  failMaxAttemptPendingCandidates,
  fetchPendingCandidates,
  getCandidateBacklogDrainLimit,
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

export interface BacklogDrainOptions {
  categoryId?: string;
  limit?: number;
  maxBatches?: number;
  skipStale?: boolean;
  recoverStale?: boolean;
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

  const drainLimit = Math.max(1, Math.min(options.limit ?? getCandidateBacklogDrainLimit(env), getCandidateBacklogDrainLimit(env)));
  const batchSize = Math.max(1, Math.min(getScoringBatchSize(env), drainLimit));
  const maxBatches = Math.max(1, Math.min(options.maxBatches ?? getMaxScoringBatchesPerRun(env), getMaxScoringBatchesPerRun(env)));

  for (let batchNo = 0; batchNo < maxBatches && result.candidatesPulled < drainLimit; batchNo++) {
    const remaining = drainLimit - result.candidatesPulled;
    const fairPickerEnabled = isFairSourcePickerEnabled(env);
    const poolLimit = fairPickerEnabled
      ? Math.min(remaining, Math.max(batchSize * 4, batchSize))
      : Math.min(batchSize, remaining);
    const pendingPool = await fetchPendingCandidates(env, poolLimit, options.categoryId);
    if (pendingPool.length === 0) break;

    const selection = selectCandidateBatchForScoring(pendingPool, Math.min(batchSize, remaining), fairPickerEnabled);
    const pending = selection.selected;
    if (pending.length === 0) break;
    result.candidatesPulled += pending.length;

    const budget = await checkScoringBudgetForBacklog(env);
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

    const batchResult = await processClaimedBatch(env, claimed);
    result.candidatesScored += batchResult.scored;
    result.candidatesSelected += batchResult.selected;
    result.candidatesRejected += batchResult.rejected;
    result.candidatesQueued += batchResult.queued;
    result.candidatesFailed += batchResult.failed;
    result.candidatesSkipped += batchResult.skipped;
    if (batchResult.stoppedByBudget) {
      result.stoppedByBudget = true;
      result.error = batchResult.error;
      break;
    }
  }

  return result;
}

async function processClaimedBatch(env: Env, rows: AICandidateRow[]): Promise<{
  scored: number;
  selected: number;
  rejected: number;
  queued: number;
  failed: number;
  skipped: number;
  stoppedByBudget: boolean;
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

  const budget = await checkScoringBudgetForBacklog(env);
  if (!budget.allowed) {
    await releaseClaimedCandidatesToPending(env, rows.map(r => r.id), budget.reason ?? 'ai_budget_exceeded', { decrementAttempt: true });
    return { ...zero, stoppedByBudget: true, error: budget.reason };
  }

  const prepared: Array<{ row: AICandidateRow; item: NormalizedItem; keys: string[] }> = [];
  let skipped = 0;
  let rejected = 0;

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

  let aiResults: AIGateResult[];
  try {
    aiResults = await runAIGate(env, items, category, whitelist, channels);
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

  for (let i = 0; i < prepared.length; i++) {
    const candidate = prepared[i]!;
    const ai = aiResults[i];
    if (!ai) {
      await releaseClaimedCandidatesToPending(env, [candidate.row.id], 'missing_ai_result');
      continue;
    }

    const itemId = itemIdForCandidate(candidate.row.id);
    const recentTopicDuplicate = await hasRecentTopicMatchForAnySemanticChannel(env, channels, ai.topicFingerprint);
    const rejectReason = recentTopicDuplicate
      ? 'similar_topic_recent_channel'
      : getItemRejectReason(ai, category, candidate.item, similarTopicRejects.has(i));
    const isRejected = rejectReason !== null;

    await saveDiscoveryItem(env, itemId, candidate.row.run_id ?? 'backlog', candidate.row.category_id, candidate.item, ai, isRejected ? 'ai_rejected' : 'ai_selected', rejectReason);
    await recordCandidateItemEvent(env, candidate.row, itemId, candidate.item, isRejected ? 'ai_rejected' : 'ai_selected', rejectReason, ai, recentTopicDuplicate ? { topicFingerprint: ai.topicFingerprint } : undefined);

    if (isRejected) {
      await recordDedupeKeys(env, candidate.keys, itemId);
      await updateCandidateStatus(env, candidate.row.id, 'ai_rejected', { lastError: rejectReason ?? undefined });
      rejected++;
      continue;
    }

    selected++;
    await recordDedupeKeys(env, candidate.keys, itemId);
    await saveDiscoveryMedia(env, itemId, candidate.item);

    const mediaRes = resolveMedia(candidate.item.media, category.media_mode as any);
    const mediaTypes = extractMediaTypes(candidate.item.media, category.media_mode as any);
    let candidateQueued = 0;

    for (const channel of channels) {
      if (!channel.enabled) continue;
      const translationKey = channelTranslationKey(channel.id);
      const translation = ai.translations[translationKey] ?? ai.translations[channel.language];
      if (!translation) {
        await recordCandidateItemEvent(env, candidate.row, itemId, candidate.item, 'translation_missing', 'translation_missing', ai, { channelId: channel.id, language: channel.language });
        continue;
      }

      const rule = await runRuleGate(env, ai, channel, candidate.item.mediaUrlExpiresSoon);
      if (!rule.approved || !rule.scheduledAt) {
        await recordCandidateItemEvent(env, candidate.row, itemId, candidate.item, 'rule_gate_rejected', rule.reason ?? 'rule_gate_rejected', ai, { channelId: channel.id, language: channel.language });
        continue;
      }

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
        scheduledAt: rule.scheduledAt,
      });

      if (inserted) {
        candidateQueued++;
        queued++;
        await recordCandidateItemEvent(env, candidate.row, itemId, candidate.item, 'queue_created', null, ai, { channelId: channel.id, language: channel.language, scheduledAt: rule.scheduledAt });
      }
    }

    await updateCandidateStatus(env, candidate.row.id, candidateQueued > 0 ? 'queued' : 'ai_selected');
  }

  return { ...zero, scored: prepared.length, selected, rejected, queued, skipped };
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

async function checkScoringBudgetForBacklog(env: Env): Promise<ScoringBudgetSnapshot> {
  const maxCalls = Math.max(0, parseInt(env.AI_MAX_CALLS_PER_DAY || '0', 10) || 0);
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

function channelTranslationKey(channelId: string): string {
  return `channel:${channelId}`;
}

function itemIdForCandidate(candidateId: string): string {
  return `item_${candidateId}`.slice(0, 120);
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
