import type { Env } from '../types';
import type {
  ApifyRotationAttemptPlan as RotationAttemptPlan,
  ApifyRotationPlan as RotationPlan,
  ApifyRotationSourceRow as SourceRow,
} from '../categories/types';
import { getCategorySourceStrategy } from '../categories/registry';
import { recordRunEvent } from './run-events';
import { fetchApifyDataset, filterApifyActorMockNoResultItems } from './apify-client';

const APIFY_API_BASE = 'https://api.apify.com/v2';

interface DatasetHealth {
  rawCount: number;
  realRawCount: number;
  actorMockCount: number;
  actorMockSamples: Array<{
    keys: string[];
    id?: unknown;
    type?: unknown;
    textPreview?: string;
  }>;
}

export interface ApifyRotationOptions {
  force?: boolean;
  dryRun?: boolean;
  onlySourceId?: string;
  /** Hard cap on number of sources fired this invocation (applies even with force). Phase 6F. */
  maxSources?: number;
  /** When true, the queue is starving → a single extra (second) paid attempt may
   *  fire if the daily second-attempt budget allows. Default false (cost-safe). */
  queueStarving?: boolean;
}

export interface ApifyRotationResult {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  bucket: number;
  rotationRunId: string;
  plans: Array<{
    sourceId: string;
    taskId: string | null;
    cohortName: string;
    cohortIndex: number | null;
    accounts: string[];
    inputOverride: Record<string, unknown>;
    actorRunId?: string | null;
    status?: string | null;
    defaultDatasetId?: string | null;
    finalAttempt?: string;
    attempts?: Array<{
      attempt: string;
      actorRunId?: string | null;
      status?: string | null;
      defaultDatasetId?: string | null;
      rawCount?: number;
      realRawCount?: number;
      actorMockCount?: number;
      error?: string;
    }>;
    error?: string;
  }>;
}

export async function runApifyRotation(
  env: Env,
  options: ApifyRotationOptions = {},
): Promise<ApifyRotationResult> {
  const started = Date.now();
  const rotationRunId = makeRotationRunId();
  const intervalHours = getRotationIntervalHours(env);
  const bucket = Math.floor(Date.now() / (intervalHours * 60 * 60 * 1000));

  if (!isRotationEnabled(env) && !options.force) {
    return {
      ok: true,
      skipped: true,
      reason: 'rotation_disabled',
      bucket,
      rotationRunId,
      plans: [],
    };
  }

  const sources = await loadRotationSources(env, options.onlySourceId);
  const allPlans = sources
    .map(source => buildRotationPlan(source, bucket))
    .filter((plan): plan is RotationPlan => Boolean(plan));

  const continuous = isContinuousRotationEnabled(env);

  // Phase 6F: in continuous mode, exactly ONE designated source fires per time
  // slot, so coverage is spread evenly across the interval instead of bursting
  // all sources in the first ~15 minutes. Legacy mode keeps the prior behavior.
  const hardCap = options.maxSources != null && options.maxSources > 0
    ? Math.max(1, Math.floor(options.maxSources))
    : Number.POSITIVE_INFINITY;

  const plans: RotationPlan[] = [];

  if (options.force || options.dryRun) {
    for (const plan of allPlans) {
      if (plans.length >= hardCap) break;
      plans.push(plan);
    }
  } else if (continuous) {
    const slotMinutes = getRotationSlotMinutes(env);
    const slot = Math.floor(Date.now() / (slotMinutes * 60 * 1000));
    let ordered = orderPlansForSlot(allPlans, slot);
    // Phase-next: optional reputation weighting with exploration (default off).
    if (isSourceReputationWeightingEnabled(env)) {
      try {
        const cfg = getSourceWeightConfig(env);
        const weights = await loadSourceWeightMap(env, cfg);
        const recentRuns = await loadRecentRunsMap(env);
        ordered = orderByReputationWeight(ordered, weights, slot, getReputationExplorationPct(env), recentRuns);
      } catch (err) {
        console.warn('[ApifyRotation] reputation weighting skipped:', err instanceof Error ? err.message : String(err));
      }
    }
    const perSlot = Math.min(hardCap, getContinuousSourcesPerSlot(env));
    // Claim the SLOT once (not per-source). The first cron tick inside a slot
    // wins and fires exactly the designated source(s); later ticks in the same
    // slot find the slot already claimed and skip — so we never fall through to
    // other sources and never re-create the burst.
    const claimed = await claimRotationSlot(env, slot);
    if (claimed) {
      for (const plan of ordered) {
        if (plans.length >= perSlot) break;
        plans.push(plan);
      }
    }
  } else {
    const maxSourcesPerTick = Math.min(hardCap, getMaxSourcesPerTick(env));
    for (const plan of allPlans) {
      if (plans.length >= maxSourcesPerTick) break;
      const claimed = await claimRotationSourceBucket(env, bucket, plan.source.id);
      if (claimed) plans.push(plan);
    }
  }

  if (plans.length === 0) {
    return {
      ok: true,
      skipped: true,
      reason: 'rotation_bucket_sources_already_claimed',
      bucket,
      rotationRunId,
      plans: [],
    };
  }

  await recordRunEvent(env, {
    runId: rotationRunId,
    eventType: 'apify.rotation.started',
    phase: 'apify_rotation',
    categoryId: rotationEventCategoryId(plans),
    metadata: {
      bucket,
      intervalHours,
      dryRun: options.dryRun === true,
      mode: continuous ? 'continuous' : 'bucket',
      firedSources: plans.length,
      remainingPlannedSources: allPlans.length,
      plannedSources: plans.map(plan => ({
        sourceId: plan.source.id,
        cohortName: plan.cohortName,
        cohortIndex: plan.cohortIndex,
        accounts: plan.accounts,
      })),
    },
  });

  const results: ApifyRotationResult['plans'] = [];

  for (const plan of plans) {
    const taskId = plan.source.apify_task_id;
    const resultBase = {
      sourceId: plan.source.id,
      taskId,
      cohortName: plan.cohortName,
      cohortIndex: plan.cohortIndex,
      accounts: plan.accounts,
      inputOverride: plan.inputOverride,
    };

    if (!taskId) {
      results.push({ ...resultBase, error: 'missing_apify_task_id' });
      continue;
    }

    if (options.dryRun) {
      results.push({
        ...resultBase,
        status: 'DRY_RUN',
        actorRunId: null,
        defaultDatasetId: null,
      });
      continue;
    }

    const attempts = buildRotationAttempts(plan);
    // Apify cost control: pick the single best attempt by history (default) and
    // cap how many PAID actor events may fire this slot (default 1).
    const orderedAttempts = isAdaptiveAttemptSelectionEnabled(env)
      ? orderAttemptsByYield(
          attempts,
          await loadAttemptYieldStats(env, plan.source.id, getAttemptYieldHistoryDays(env)),
          getAttemptYieldMinSample(env),
        )
      : attempts;
    const budget = decideAttemptBudget({
      baseMaxAttempts: getMaxAttemptsPerSlot(env),
      totalAttempts: orderedAttempts.length,
      queueStarving: options.queueStarving === true,
      secondAttemptDailyBudget: getSecondAttemptDailyBudget(env),
      secondAttemptDailyUsed: await readSecondAttemptBudgetUsed(env),
    });
    const attemptsToRun = orderedAttempts.slice(0, budget.maxAttempts);
    const attemptResults: NonNullable<ApifyRotationResult['plans'][number]['attempts']> = [];
    let selected: { attempt: RotationAttemptPlan; run: any } | null = null;
    let lastFailure: string | null = null;
    let secondAttemptCharged = false;

    for (let attemptIndex = 0; attemptIndex < attemptsToRun.length; attemptIndex++) {
      const attempt = attemptsToRun[attemptIndex];
      if (!attempt) continue;
      // Consuming the daily second-attempt budget the first time we actually fire
      // a fallback attempt (index >= 1) in a starving slot.
      if (attemptIndex >= 1 && budget.usesSecondAttemptBudget && !secondAttemptCharged) {
        await incrementSecondAttemptBudgetUsed(env);
        secondAttemptCharged = true;
      }
      try {
        const run = await runApifyTask(env, taskId, attempt.inputOverride);
        const datasetId = safeString(run.defaultDatasetId);
        const health = datasetId
          ? await inspectApifyDatasetHealth(env, datasetId)
          : emptyDatasetHealth();

        attemptResults.push({
          attempt: attempt.attempt,
          actorRunId: safeString(run.id),
          status: safeString(run.status),
          defaultDatasetId: datasetId,
          rawCount: health.rawCount,
          realRawCount: health.realRawCount,
          actorMockCount: health.actorMockCount,
        });

        await recordRunEvent(env, {
          runId: rotationRunId,
          eventType: 'apify.rotation.task_started',
          phase: 'apify_rotation',
          categoryId: plan.source.category_id,
          platform: plan.source.platform,
          sourceId: plan.source.id,
          datasetId: datasetId ?? undefined,
          actorRunId: safeString(run.id) ?? undefined,
          durationMs: Date.now() - started,
          metadata: {
            bucket,
            attempt: attempt.attempt,
            attemptReason: attempt.reason,
            cohortName: plan.cohortName,
            cohortIndex: plan.cohortIndex,
            accounts: plan.accounts,
            inputOverride: attempt.inputOverride,
            status: safeString(run.status),
            datasetHealth: health,
          },
        });

        if (datasetId && health.realRawCount > 0) {
          selected = { attempt, run };
          break;
        }

        lastFailure = datasetId ? 'apify_actor_mock_no_results' : 'missing_default_dataset_id';

        await recordRunEvent(env, {
          runId: rotationRunId,
          eventType: 'apify.rotation.dataset_unhealthy',
          phase: 'apify_rotation',
          severity: 'warn',
          message: datasetId
            ? 'Apify task succeeded but returned no real tweet rows; retrying with fallback query.'
            : 'Apify task succeeded without a default dataset id; retrying with fallback query.',
          categoryId: plan.source.category_id,
          platform: plan.source.platform,
          sourceId: plan.source.id,
          datasetId: datasetId ?? undefined,
          actorRunId: safeString(run.id) ?? undefined,
          durationMs: Date.now() - started,
          metadata: {
            bucket,
            attempt: attempt.attempt,
            nextAttemptAvailable: attemptIndex < attemptsToRun.length - 1,
            cohortName: plan.cohortName,
            cohortIndex: plan.cohortIndex,
            accounts: plan.accounts,
            inputOverride: attempt.inputOverride,
            datasetHealth: health,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastFailure = message;

        attemptResults.push({
          attempt: attempt.attempt,
          error: message,
        });

        await recordRunEvent(env, {
          runId: rotationRunId,
          eventType: 'apify.rotation.task_failed',
          phase: 'apify_rotation',
          severity: 'error',
          message,
          categoryId: plan.source.category_id,
          platform: plan.source.platform,
          sourceId: plan.source.id,
          durationMs: Date.now() - started,
          metadata: {
            bucket,
            attempt: attempt.attempt,
            attemptReason: attempt.reason,
            cohortName: plan.cohortName,
            cohortIndex: plan.cohortIndex,
            accounts: plan.accounts,
            inputOverride: attempt.inputOverride,
          },
        });
      }
    }

    if (selected) {
      const selectedDatasetId = safeString(selected.run.defaultDatasetId);
      if (selectedDatasetId) {
        await syncApifySourceDataset(env, plan.source.id, selectedDatasetId);
      }

      results.push({
        ...resultBase,
        inputOverride: selected.attempt.inputOverride,
        finalAttempt: selected.attempt.attempt,
        attempts: attemptResults,
        actorRunId: safeString(selected.run.id),
        status: safeString(selected.run.status),
        defaultDatasetId: selectedDatasetId,
      });
    } else {
      results.push({
        ...resultBase,
        attempts: attemptResults,
        error: lastFailure ?? 'apify_rotation_no_healthy_dataset',
      });
    }
  }

  const ok = results.every(row => !row.error);

  await recordRunEvent(env, {
    runId: rotationRunId,
    eventType: ok ? 'apify.rotation.completed' : 'apify.rotation.completed_with_errors',
    phase: 'apify_rotation',
    severity: ok ? 'info' : 'warn',
    categoryId: rotationEventCategoryId(plans),
    durationMs: Date.now() - started,
    metadata: {
      bucket,
      dryRun: options.dryRun === true,
      results,
    },
  });

  return {
    ok,
    skipped: false,
    bucket,
    rotationRunId,
    plans: results,
  };
}

function buildRotationPlan(source: SourceRow, bucket: number): RotationPlan | null {
  const strategy = getCategorySourceStrategy(source.category_id);
  if (!strategy.canHandleSource(source)) return null;
  return strategy.buildRotationPlan(source, bucket);
}

function buildRotationAttempts(plan: RotationPlan): RotationAttemptPlan[] {
  const strategy = getCategorySourceStrategy(plan.source.category_id);
  return strategy.buildRotationAttempts?.(plan) ?? [{
    attempt: 'primary',
    inputOverride: plan.inputOverride,
  }];
}

async function syncApifySourceDataset(env: Env, sourceId: string, datasetId: string): Promise<void> {
  try {
    await env.DB
      .prepare('UPDATE apify_sources SET apify_dataset_id=?, last_dataset_id=? WHERE id=?')
      .bind(datasetId, datasetId, sourceId)
      .run();
  } catch (err) {
    console.warn('[ApifyRotation] Failed to sync source dataset:', err instanceof Error ? err.message : String(err));
  }
}

// ── Apify cost control: single paid actor event per source/slot by default ──
//
// Each attempt is a PAID actor event. The legacy loop fired every attempt
// (primary → fallback → rescue) until one returned real rows, so a dry primary
// silently doubled/tripled the per-slot cost. These helpers cap attempts to a
// budget (default 1) and, when only one event is allowed, pick the attempt with
// the best historical healthy-yield instead of blindly trying primary first.

/** Base attempts allowed per source per slot. Default 1 (one paid event). Set
 *  to >=3 to restore the legacy blind primary→fallback→rescue chain. */
export function getMaxAttemptsPerSlot(env: Env): number {
  const n = parseInt(String((env as any).APIFY_MAX_ATTEMPTS_PER_SLOT ?? '1'), 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** When true (default), choose the single attempt by historical yield. When
 *  false, keep the strategy's default order (primary first). */
export function isAdaptiveAttemptSelectionEnabled(env: Env): boolean {
  return String((env as any).APIFY_ADAPTIVE_ATTEMPT_SELECTION_ENABLED ?? 'true').toLowerCase() !== 'false';
}

/** Max number of EXTRA (second) paid attempts allowed per day, consumed only
 *  while the queue is starving. Default 0 → second attempts never fire. */
export function getSecondAttemptDailyBudget(env: Env): number {
  const n = parseInt(String((env as any).APIFY_SECOND_ATTEMPT_DAILY_BUDGET ?? '0'), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function getAttemptYieldHistoryDays(env: Env): number {
  const n = parseInt(String((env as any).APIFY_ATTEMPT_YIELD_HISTORY_DAYS ?? '7'), 10);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

export function getAttemptYieldMinSample(env: Env): number {
  const n = parseInt(String((env as any).APIFY_ATTEMPT_YIELD_MIN_SAMPLE ?? '3'), 10);
  return Number.isFinite(n) && n >= 1 ? n : 3;
}

export interface AttemptYieldStat { healthy: number; total: number }

/**
 * PURE. Reorder attempts so the one with the best historical healthy-yield rate
 * (realRawCount > 0) goes first. Attempts with at least `minSample` runs of
 * history are ranked above those without; ties and insufficient-history attempts
 * keep their original (strategy default) order — a safe fallback default. When no
 * attempt has enough history, the original order is returned unchanged.
 */
export function orderAttemptsByYield<T extends { attempt: string }>(
  attempts: T[],
  stats: Map<string, AttemptYieldStat>,
  minSample: number,
): T[] {
  const score = (name: string) => {
    const s = stats.get(name);
    if (!s || s.total < minSample) return { hasHistory: 0, rate: -1 };
    return { hasHistory: 1, rate: s.total > 0 ? s.healthy / s.total : 0 };
  };
  return attempts
    .map((a, i) => ({ a, i, ...score(a.attempt) }))
    .sort((x, y) =>
      (y.hasHistory - x.hasHistory) ||  // attempts with history first
      (y.rate - x.rate) ||              // higher healthy-yield first
      (x.i - y.i))                      // stable: preserve default order
    .map(e => e.a);
}

/**
 * PURE. Decide how many paid attempts to run this slot.
 * - If base >= 2: explicit multi-attempt mode (legacy) → run that many, no budget.
 * - If base == 1 (default): run exactly ONE, unless the queue is starving AND a
 *   daily second-attempt budget remains AND a real fallback attempt exists.
 */
export function decideAttemptBudget(args: {
  baseMaxAttempts: number;
  totalAttempts: number;
  queueStarving: boolean;
  secondAttemptDailyBudget: number;
  secondAttemptDailyUsed: number;
}): { maxAttempts: number; usesSecondAttemptBudget: boolean } {
  const total = Math.max(1, args.totalAttempts);
  const base = Math.max(1, Math.min(args.baseMaxAttempts, total));
  if (base >= 2) return { maxAttempts: base, usesSecondAttemptBudget: false };
  const budgetLeft = args.secondAttemptDailyBudget - args.secondAttemptDailyUsed;
  if (args.queueStarving && budgetLeft > 0 && total >= 2) {
    return { maxAttempts: 2, usesSecondAttemptBudget: true };
  }
  return { maxAttempts: 1, usesSecondAttemptBudget: false };
}

/** IMPROVEMENT #1: downstream-aware attempt yield metric (flag-gated).
 *
 *  The legacy signal counted an attempt "healthy" if realRawCount > 0 — but an
 *  attempt that returns 30 duplicate tweets is useless. When
 *  APIFY_ATTEMPT_YIELD_DOWNSTREAM_ENABLED=true, an attempt's run is counted
 *  "healthy" only if its dataset later produced real downstream value
 *  (items_new > 0 OR items_queued > 0) in discovery_runs. Falls back to the
 *  legacy realRawCount>0 signal when the flag is off or when no discovery_runs
 *  row exists yet for that dataset (e.g. curation hasn't run).
 *
 *  No new table required — it joins run_events (attempt+dataset) to
 *  discovery_runs (outcome) by apify_dataset_id.
 */
function isDownstreamYieldEnabled(env: Env): boolean {
  return String((env as any).APIFY_ATTEMPT_YIELD_DOWNSTREAM_ENABLED ?? '').toLowerCase() === 'true';
}

async function loadAttemptYieldStats(env: Env, sourceId: string, days: number): Promise<Map<string, AttemptYieldStat>> {
  const map = new Map<string, AttemptYieldStat>();
  if (!env.DB) return map;

  const downstream = isDownstreamYieldEnabled(env);

  try {
    const res = await env.DB.prepare(`
      SELECT metadata_json, dataset_id FROM run_events
      WHERE event_type = 'apify.rotation.task_started'
        AND source_id = ?
        AND created_at > datetime('now','-' || ? || ' days')
    `).bind(sourceId, String(days)).all<{ metadata_json: string; dataset_id: string | null }>();

    // Optional: load downstream outcome per dataset_id (only when flag on).
    let outcomeByDataset: Map<string, { newItems: number; queued: number }> | null = null;
    if (downstream) {
      outcomeByDataset = new Map();
      try {
        const dr = await env.DB.prepare(`
          SELECT apify_dataset_id AS ds,
                 SUM(items_new) AS new_items,
                 SUM(items_queued) AS queued
          FROM discovery_runs
          WHERE created_at > datetime('now','-' || ? || ' days')
          GROUP BY apify_dataset_id
        `).bind(String(days)).all<{ ds: string; new_items: number; queued: number }>();
        for (const r of dr.results ?? []) {
          if (r.ds) outcomeByDataset.set(String(r.ds), { newItems: Number(r.new_items) || 0, queued: Number(r.queued) || 0 });
        }
      } catch { outcomeByDataset = null; /* fall back to legacy below */ }
    }

    for (const row of res.results ?? []) {
      let meta: any;
      try { meta = JSON.parse(String(row.metadata_json ?? '{}')); } catch { continue; }
      const name = String(meta?.attempt ?? '').trim();
      if (!name) continue;

      const real = Number(meta?.datasetHealth?.realRawCount ?? 0) || 0;
      const datasetId = String(row.dataset_id ?? '').trim();

      let healthy: boolean;
      if (downstream && outcomeByDataset && datasetId && outcomeByDataset.has(datasetId)) {
        const o = outcomeByDataset.get(datasetId)!;
        healthy = o.newItems > 0 || o.queued > 0; // downstream-aware
      } else {
        healthy = real > 0; // legacy fallback
      }

      const cur = map.get(name) ?? { healthy: 0, total: 0 };
      cur.total += 1;
      if (healthy) cur.healthy += 1;
      map.set(name, cur);
    }
  } catch (err) {
    console.warn('[ApifyRotation] loadAttemptYieldStats skipped:', err instanceof Error ? err.message : String(err));
  }
  return map;
}

function secondAttemptBudgetKey(): string {
  return `apify_second_attempt_budget_used:${new Date().toISOString().slice(0, 10)}`;
}

async function readSecondAttemptBudgetUsed(env: Env): Promise<number> {
  if (!env.DB) return 0;
  try {
    const row = await env.DB.prepare(`SELECT value FROM settings WHERE key=?`).bind(secondAttemptBudgetKey()).first<{ value: string }>();
    const n = parseInt(String(row?.value ?? '0'), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

async function incrementSecondAttemptBudgetUsed(env: Env): Promise<void> {
  if (!env.DB) return;
  const key = secondAttemptBudgetKey();
  try {
    const used = await readSecondAttemptBudgetUsed(env);
    await env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).bind(key, String(used + 1)).run();
  } catch (err) {
    console.warn('[ApifyRotation] second-attempt budget increment skipped:', err instanceof Error ? err.message : String(err));
  }
}

function rotationEventCategoryId(plans: RotationPlan[]): string {
  const ids = Array.from(new Set(plans.map(plan => String(plan.source.category_id ?? '').trim()).filter(Boolean)));
  if (ids.length === 1) return ids[0]!;
  if (ids.length > 1) return 'mixed';
  return 'unknown';
}

async function inspectApifyDatasetHealth(env: Env, datasetId: string): Promise<DatasetHealth> {
  const raw = await fetchApifyDataset(datasetId, env.APIFY_TOKEN, getRotationDatasetProbeLimit(env));
  const filtered = filterApifyActorMockNoResultItems(raw);

  return {
    rawCount: raw.length,
    realRawCount: filtered.realItems.length,
    actorMockCount: filtered.actorMockCount,
    actorMockSamples: filtered.actorMockSamples,
  };
}

function emptyDatasetHealth(): DatasetHealth {
  return {
    rawCount: 0,
    realRawCount: 0,
    actorMockCount: 0,
    actorMockSamples: [],
  };
}

function getRotationDatasetProbeLimit(env: Env): number {
  const value = Number((env as any).APIFY_ROTATION_DATASET_PROBE_LIMIT ?? 30);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 100) : 30;
}

/** IMPROVEMENT #3: retries for transient Apify failures.
 *  Retries only on network errors and 5xx/429 (transient). 4xx (bad input,
 *  auth) fail fast — retrying them just burns time. Exponential backoff with
 *  jitter. Default 2 retries (3 attempts total), env-tunable. This does NOT
 *  increase paid actor events for the success case; it only re-issues a run
 *  when the previous HTTP call genuinely failed to start/complete. */
function getApifyMaxRetries(env: Env): number {
  // High-risk fix: default 0 (was 2). POST /actor-tasks/.../runs is NOT
  // idempotent — if the request times out AFTER Apify already started the run,
  // a retry creates a SECOND paid actor run. Given this project's cost history,
  // retries are OFF by default and must be opted into explicitly via
  // APIFY_TASK_MAX_RETRIES. Even then, only 429/5xx and pre-start network
  // errors are retried; see isTransientApifyStatus.
  const n = parseInt(String((env as any).APIFY_TASK_MAX_RETRIES ?? '0'), 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 5) : 0;
}

function isTransientApifyStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

async function runApifyTask(
  env: Env,
  taskId: string,
  inputOverride: Record<string, unknown>,
): Promise<any> {
  const waitForFinish = getWaitForFinishSeconds(env);
  const url =
    `${APIFY_API_BASE}/actor-tasks/${encodeURIComponent(taskId)}/runs` +
    `?token=${encodeURIComponent(env.APIFY_TOKEN)}` +
    `&waitForFinish=${waitForFinish}`;

  const maxRetries = getApifyMaxRetries(env);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(inputOverride),
        signal: AbortSignal.timeout((waitForFinish + 10) * 1000),
      });

      const text = await response.text();

      if (!response.ok) {
        // Fail fast on non-transient (4xx) — retrying won't help.
        if (!isTransientApifyStatus(response.status)) {
          throw new Error(`Apify task run failed ${response.status}: ${text.slice(0, 500)}`);
        }
        // Transient — record and retry (if attempts remain).
        lastError = new Error(`Apify task transient ${response.status}: ${text.slice(0, 200)}`);
        if (attempt < maxRetries) {
          await sleepWithBackoff(attempt);
          continue;
        }
        throw lastError;
      }

      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      return json?.data ?? json ?? {};
    } catch (err) {
      // Network error / timeout / abort → transient, retry if attempts remain.
      lastError = err instanceof Error ? err : new Error(String(err));
      // If it was a fail-fast 4xx thrown above, do not retry.
      if (/Apify task run failed 4\d\d/.test(lastError.message)) throw lastError;
      if (attempt < maxRetries) {
        await sleepWithBackoff(attempt);
        continue;
      }
      throw lastError;
    }
  }
  throw lastError ?? new Error('Apify task run failed: unknown');
}

/** Exponential backoff with jitter: ~0.5s, ~1s, ~2s ... capped at 8s. */
async function sleepWithBackoff(attempt: number): Promise<void> {
  const base = Math.min(500 * Math.pow(2, attempt), 8000);
  const jitter = Math.floor(Math.random() * 250);
  await new Promise(resolve => setTimeout(resolve, base + jitter));
}

async function loadRotationSources(env: Env, onlySourceId?: string): Promise<SourceRow[]> {
  const rows = await env.DB.prepare(`
    SELECT id, label, category_id, platform, apify_task_id
    FROM apify_sources
    WHERE enabled=1
    ORDER BY id
  `).all<SourceRow>();

  return (rows.results ?? [])
    .filter(row => getCategorySourceStrategy(row.category_id).canHandleSource(row))
    .filter(row => !onlySourceId || row.id === onlySourceId);
}

async function claimRotationSourceBucket(env: Env, bucket: number, sourceId: string): Promise<boolean> {
  const key = `apify_rotation_bucket_${bucket}_${sourceId}`;
  const value = 'claimed';

  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
  `).bind(key, value).run();

  return (result.meta.changes ?? 0) > 0;
}

function isRotationEnabled(env: Env): boolean {
  return String(env.APIFY_ROTATION_ENABLED ?? '').toLowerCase() === 'true';
}

function isContinuousRotationEnabled(env: Env): boolean {
  return String((env as any).APIFY_ROTATION_CONTINUOUS_ENABLED ?? '').toLowerCase() === 'true';
}

export function getRotationSlotMinutes(env: Env): number {
  const value = Number((env as any).APIFY_ROTATION_SLOT_MINUTES ?? 30);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.max(Math.floor(value), 5), 180) : 30;
}

function getContinuousSourcesPerSlot(env: Env): number {
  const value = Number((env as any).APIFY_ROTATION_CONTINUOUS_SOURCES_PER_SLOT ?? 1);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 6) : 1;
}

/**
 * Pure: rotate the plan order so a different source leads each slot. The
 * designated source for `slot` is `slot % N`; remaining sources follow as
 * fallbacks (used only if perSlot > 1). This spreads coverage across the
 * interval deterministically.
 */
export function orderPlansForSlot<T>(plans: T[], slot: number): T[] {
  const n = plans.length;
  if (n <= 1) return plans.slice();
  const start = ((slot % n) + n) % n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(plans[(start + i) % n]!);
  return out;
}

async function claimRotationSlot(env: Env, slot: number): Promise<boolean> {
  const key = `apify_rotation_slot_${slot}`;
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO settings (key, value, updated_at)
    VALUES (?, 'claimed', CURRENT_TIMESTAMP)
  `).bind(key).run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Pick the source the starvation controller should scrape. Instead of always
 * hitting the alphabetically-first source (the old `force` behavior), return
 * the source designated for the CURRENT slot, so repeated starvation triggers
 * rotate across sources and don't re-create dominance. Returns null if no
 * eligible source.
 */
export async function getStarvationRotationSourceId(env: Env): Promise<string | null> {
  try {
    const sources = await loadRotationSources(env);
    const bucket = Math.floor(Date.now() / (getRotationIntervalHours(env) * 60 * 60 * 1000));
    const plans = sources
      .map(source => buildRotationPlan(source, bucket))
      .filter((plan): plan is RotationPlan => Boolean(plan));
    if (plans.length === 0) return null;
    const slotMinutes = getRotationSlotMinutes(env);
    const slot = Math.floor(Date.now() / (slotMinutes * 60 * 1000));
    return orderPlansForSlot(plans, slot)[0]?.source.id ?? null;
  } catch (err) {
    console.warn('[ApifyRotation] starvation source pick skipped:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Phase-next: pick a rotation source that IMPROVES queue diversity by avoiding
 * the account currently dominating the scheduled queue. Falls back to the
 * normal starvation pick when no avoid hint is given or every candidate maps to
 * the dominant account.
 */
export async function getDiversityRotationSourceId(
  env: Env, opts: { avoidAccount?: string | null; avoidSourceId?: string | null } = {},
): Promise<string | null> {
  const avoid = normalizeHandle(opts.avoidAccount);
  const avoidSid = String(opts.avoidSourceId ?? '').trim();
  if (!avoid && !avoidSid) return getStarvationRotationSourceId(env);
  try {
    const sources = await loadRotationSources(env);
    const bucket = Math.floor(Date.now() / (getRotationIntervalHours(env) * 60 * 60 * 1000));
    const plans = sources
      .map(source => buildRotationPlan(source, bucket))
      .filter((plan): plan is RotationPlan => Boolean(plan));
    if (plans.length === 0) return null;
    const slotMinutes = getRotationSlotMinutes(env);
    const slot = Math.floor(Date.now() / (slotMinutes * 60 * 1000));
    const ordered = orderPlansForSlot(plans, slot);
    // first slot-ordered plan that is NOT the dominant source_id and whose
    // accounts do NOT include the dominant account
    const diverse = ordered.find(p =>
      (!avoidSid || String(p.source.id) !== avoidSid) &&
      (!avoid || !(p.accounts ?? []).some(a => normalizeHandle(a) === avoid)),
    );
    return (diverse ?? ordered[0])?.source.id ?? null;
  } catch (err) {
    console.warn('[ApifyRotation] diversity source pick skipped:', err instanceof Error ? err.message : String(err));
    return getStarvationRotationSourceId(env);
  }
}

function normalizeHandle(v: unknown): string {
  return String(v ?? '').toLowerCase().replace(/^@/, '').trim();
}

/**
 * Phase 6I maintenance: rotation claim keys (`apify_rotation_bucket_*` and
 * `apify_rotation_slot_*`) are written every bucket/slot and were never
 * cleaned up — production had 150+ stale rows. Delete keys whose bucket/slot
 * index is well in the past. Safe + idempotent; failures are swallowed.
 */
export async function cleanupOldRotationClaims(env: Env): Promise<{ deleted: number }> {
  try {
    const intervalHours = getRotationIntervalHours(env);
    const slotMinutes = getRotationSlotMinutes(env);
    const currentBucket = Math.floor(Date.now() / (intervalHours * 60 * 60 * 1000));
    const currentSlot = Math.floor(Date.now() / (slotMinutes * 60 * 1000));
    const keepBucketsFrom = currentBucket - 8;   // ~24h of buckets at 3h
    const keepSlotsFrom = currentSlot - 96;       // ~48h of slots at 30m

    const rows = await env.DB.prepare(
      `SELECT key FROM settings WHERE key LIKE 'apify_rotation_bucket_%' OR key LIKE 'apify_rotation_slot_%'`,
    ).all<{ key: string }>();

    const stale: string[] = [];
    for (const r of rows.results ?? []) {
      const m = /^apify_rotation_(bucket|slot)_(\d+)/.exec(r.key);
      if (!m) continue;
      const idx = Number(m[2]);
      if (m[1] === 'bucket' && idx < keepBucketsFrom) stale.push(r.key);
      if (m[1] === 'slot' && idx < keepSlotsFrom) stale.push(r.key);
    }

    let deleted = 0;
    for (const key of stale) {
      await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
      deleted++;
    }

    // IMPROVEMENT #6: sweep orphaned dataset_processing:* locks older than 2h.
    // Normal locks are released by Patch B on completion/failure; this only
    // catches locks left by a worker killed mid-run. Safe: a 2h-old lock is far
    // past Patch B's 30-min stale-reclaim window, so no active run depends on it.
    try {
      const orphanLocks = await env.DB.prepare(
        `DELETE FROM settings
         WHERE key LIKE 'dataset_processing:%'
           AND updated_at <= datetime('now','-2 hours')`,
      ).run();
      const lockDeleted = orphanLocks.meta.changes ?? 0;
      if (lockDeleted > 0) {
        console.log('[ApifyRotation] cleanup deleted', lockDeleted, 'orphaned dataset locks');
        deleted += lockDeleted;
      }
    } catch (err) {
      console.warn('[ApifyRotation] dataset lock cleanup skipped:', err instanceof Error ? err.message : String(err));
    }

    if (deleted > 0) console.log('[ApifyRotation] claim cleanup deleted', deleted, 'total stale keys');
    return { deleted };
  } catch (err) {
    console.warn('[ApifyRotation] claim cleanup skipped:', err instanceof Error ? err.message : String(err));
    return { deleted: 0 };
  }
}

function getRotationIntervalHours(env: Env): number {
  const value = Number(env.APIFY_ROTATION_INTERVAL_HOURS ?? 2);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 24) : 2;
}

function getWaitForFinishSeconds(env: Env): number {
  const value = Number(env.APIFY_ROTATION_WAIT_FOR_FINISH_SECONDS ?? 60);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 60) : 60;
}

function getMaxSourcesPerTick(env: Env): number {
  const value = Number(env.APIFY_ROTATION_MAX_SOURCES_PER_TICK ?? 2);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 6) : 2;
}

function safeString(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text ? text : null;
}

function makeRotationRunId(): string {
  return `apify_rotation_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Phase-next: active source-reputation weighting (flag-gated, default off) ──
// Pure scaffolding so it can be enabled later WITHOUT another code change.

export function isSourceReputationWeightingEnabled(env: Env): boolean {
  return String((env as any).SOURCE_REPUTATION_WEIGHTING_ENABLED ?? '').toLowerCase() === 'true';
}

export interface SourceWeightStats {
  published: number;
  rejected: number;
  sample: number; // total scored/seen
}

export interface SourceWeightConfig {
  minSample: number;   // below this, return neutral weight (exploration protects new sources)
  maxWeight: number;
  minWeight: number;
}

export function getSourceWeightConfig(env: Env): SourceWeightConfig {
  const num = (k: string, d: number) => {
    const n = parseFloat(String((env as any)[k] ?? ''));
    return Number.isFinite(n) ? n : d;
  };
  return {
    minSample: Math.max(1, Math.floor(num('SOURCE_REPUTATION_MIN_SAMPLE', 20))),
    maxWeight: num('SOURCE_REPUTATION_MAX_WEIGHT', 2.0),
    minWeight: num('SOURCE_REPUTATION_MIN_WEIGHT', 0.3),
  };
}

export function getReputationExplorationPct(env: Env): number {
  const n = parseFloat(String((env as any).SOURCE_REPUTATION_EXPLORATION_PCT ?? '20'));
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 20;
}

/** Pure: a selection weight in [minWeight, maxWeight] from a source's stats. */
export function computeSourceSelectionWeight(stats: SourceWeightStats, cfg: SourceWeightConfig): number {
  if (!stats || stats.sample < cfg.minSample) return 1; // neutral until enough data
  const denom = stats.published + stats.rejected;
  const acceptance = denom > 0 ? stats.published / denom : 0; // 0..1
  // map acceptance 0..1 → [minWeight, maxWeight]
  const w = cfg.minWeight + acceptance * (cfg.maxWeight - cfg.minWeight);
  return Math.max(cfg.minWeight, Math.min(cfg.maxWeight, w));
}

/**
 * Pure: weighted-FAIR ordering with a recent-run cooldown. Reputation biases
 * the order, but a source that ran recently is penalised so a single
 * high-reputation source can't dominate every non-exploration slot (which would
 * re-create the source-dominance we are trying to fix). An exploration fraction
 * of slots is still pure round-robin so new/low-data sources get real turns.
 *
 * effectiveScore = weight / (1 + recentRuns); ties broken by fewer recent runs,
 * then original order.
 */
export function orderByReputationWeight<T extends { source: { id: string } }>(
  plans: T[],
  weightBySourceId: Map<string, number>,
  slot: number,
  explorationPct: number,
  recentRunsBySourceId?: Map<string, number>,
): T[] {
  if (plans.length <= 1) return plans;
  const everyN = explorationPct > 0 ? Math.max(2, Math.round(100 / explorationPct)) : 0;
  if (everyN > 0 && slot % everyN === 0) return plans; // exploration slot → round-robin
  return plans
    .map((p, i) => {
      const w = weightBySourceId.get(p.source.id) ?? 1;
      const recent = recentRunsBySourceId?.get(p.source.id) ?? 0;
      return { p, i, recent, eff: w / (1 + recent) };
    })
    .sort((a, b) => (b.eff - a.eff) || (a.recent - b.recent) || (a.i - b.i))
    .map(s => s.p);
}

/** Build a source.id → selection-weight map from recent candidate outcomes. */
/** Build a source.id → selection-weight map from recent candidate OUTCOMES.
 *  Positive signal is weighted by how far an item actually got:
 *  published (1.0) > queued (0.7) > ai_selected-but-not-queued (0.25). A source
 *  that only gets `ai_selected` but never reaches the queue earns little weight,
 *  so a single AI "smile" can't push a low-yield source back into dominance. */
async function loadSourceWeightMap(env: Env, cfg: SourceWeightConfig): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!env.DB) return map;
  try {
    const res = await env.DB.prepare(`
      SELECT source_id AS sid,
             SUM(CASE WHEN status = 'queued'      THEN 1 ELSE 0 END) AS queued,
             SUM(CASE WHEN status = 'ai_selected' THEN 1 ELSE 0 END) AS ai_selected,
             SUM(CASE WHEN status = 'ai_rejected' THEN 1 ELSE 0 END) AS rejected,
             COUNT(*) AS sample
      FROM ai_candidate_queue
      WHERE created_at > datetime('now','-7 day')
      GROUP BY source_id
    `).all<{ sid: string; queued: number; ai_selected: number; rejected: number; sample: number }>();

    // real published counts per source_id (publish_queue → ai_candidate_queue)
    const publishedBySid = new Map<string, number>();
    try {
      const pub = await env.DB.prepare(`
        SELECT c.source_id AS sid, COUNT(*) AS published
        FROM publish_queue q JOIN ai_candidate_queue c ON c.id = q.candidate_id
        WHERE q.status='published' AND q.published_at >= unixepoch('now','-7 day')
        GROUP BY c.source_id
      `).all<{ sid: string; published: number }>();
      for (const r of pub.results ?? []) if (r.sid) publishedBySid.set(String(r.sid), Number(r.published) || 0);
    } catch { /* publish_queue join best-effort */ }

    for (const r of res.results ?? []) {
      if (!r.sid) continue;
      const queued = Number(r.queued) || 0;
      const aiSelected = Number(r.ai_selected) || 0;
      const rejected = Number(r.rejected) || 0;
      const published = publishedBySid.get(String(r.sid)) ?? 0;
      const weightedPositive = published * 1.0 + queued * 0.7 + aiSelected * 0.25;
      map.set(String(r.sid), computeSourceSelectionWeight(
        { published: weightedPositive, rejected, sample: Number(r.sample) || 0 },
        cfg,
      ));
    }
  } catch (err) {
    console.warn('[ApifyRotation] loadSourceWeightMap skipped:', err instanceof Error ? err.message : String(err));
  }
  return map;
}

export function getRecentRunCooldownSlots(env: Env): number {
  const n = parseInt(String((env as any).SOURCE_REPUTATION_RECENT_RUN_COOLDOWN_SLOTS ?? '6'), 10);
  return Number.isFinite(n) && n > 0 ? n : 6;
}

/** Count how many candidates each source produced in the recent cooldown window
 *  (a cheap proxy for "scraped recently" used to cool down dominant sources). */
/** Count how many times each source was actually SCRAPED in the recent cooldown
 *  window. Prefers run_events (apify.rotation.task_started) — the true scrape
 *  signal — and falls back to ai_candidate_queue when run_events lacks rows. */
async function loadRecentRunsMap(env: Env): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!env.DB) return map;
  const slots = getRecentRunCooldownSlots(env);
  const minutes = getRotationSlotMinutes(env) * slots;
  try {
    const res = await env.DB.prepare(`
      SELECT source_id AS sid, COUNT(*) AS runs
      FROM run_events
      WHERE event_type = 'apify.rotation.task_started'
        AND source_id IS NOT NULL
        AND created_at > datetime('now','-' || ? || ' minutes')
      GROUP BY source_id
    `).bind(String(minutes)).all<{ sid: string; runs: number }>();
    for (const r of res.results ?? []) if (r.sid) map.set(String(r.sid), Number(r.runs) || 0);
    if (map.size > 0) return map;
  } catch (err) {
    console.warn('[ApifyRotation] loadRecentRunsMap(run_events) skipped:', err instanceof Error ? err.message : String(err));
  }
  // Fallback: candidate-queue activity (a source that produced candidates was scraped).
  try {
    const res = await env.DB.prepare(`
      SELECT source_id AS sid, COUNT(DISTINCT run_id) AS runs
      FROM ai_candidate_queue
      WHERE created_at > datetime('now','-' || ? || ' minutes')
      GROUP BY source_id
    `).bind(String(minutes)).all<{ sid: string; runs: number }>();
    for (const r of res.results ?? []) if (r.sid) map.set(String(r.sid), Number(r.runs) || 0);
  } catch (err) {
    console.warn('[ApifyRotation] loadRecentRunsMap(fallback) skipped:', err instanceof Error ? err.message : String(err));
  }
  return map;
}

// ── Read-only preview of what reputation weighting WOULD do (no side effects) ──

export interface SourceReputationPreviewRow {
  sourceId: string;
  currentWeight: number;
  recentRuns: number;
  effectiveWeight: number;
  wouldRank: number; // 1 = picked first in a weighted (non-exploration) slot
}
export interface SourceReputationPreview {
  generatedAt: string;
  weightingEnabled: boolean;
  explorationPct: number;
  cooldownSlots: number;
  nextSlotIsExploration: boolean;
  rows: SourceReputationPreviewRow[];
}

export async function buildSourceReputationPreview(env: Env): Promise<SourceReputationPreview> {
  const explorationPct = getReputationExplorationPct(env);
  const cooldownSlots = getRecentRunCooldownSlots(env);
  const slotMinutes = getRotationSlotMinutes(env);
  const slot = Math.floor(Date.now() / (slotMinutes * 60 * 1000));
  const everyN = explorationPct > 0 ? Math.max(2, Math.round(100 / explorationPct)) : 0;
  // the NEXT slot (slot+1) is the one operators care about
  const nextSlotIsExploration = everyN > 0 && (slot + 1) % everyN === 0;

  const base: SourceReputationPreview = {
    generatedAt: new Date().toISOString(),
    weightingEnabled: isSourceReputationWeightingEnabled(env),
    explorationPct, cooldownSlots, nextSlotIsExploration, rows: [],
  };
  if (!env.DB) return base;
  try {
    const cfg = getSourceWeightConfig(env);
    const weights = await loadSourceWeightMap(env, cfg);
    const recent = await loadRecentRunsMap(env);
    const sids = new Set<string>([...weights.keys(), ...recent.keys()]);
    const rows: SourceReputationPreviewRow[] = Array.from(sids).map(sid => {
      const w = weights.get(sid) ?? 1;
      const r = recent.get(sid) ?? 0;
      return { sourceId: sid, currentWeight: Math.round(w * 1000) / 1000, recentRuns: r, effectiveWeight: Math.round((w / (1 + r)) * 1000) / 1000, wouldRank: 0 };
    });
    rows.sort((a, b) => (b.effectiveWeight - a.effectiveWeight) || (a.recentRuns - b.recentRuns) || a.sourceId.localeCompare(b.sourceId));
    rows.forEach((row, i) => { row.wouldRank = i + 1; });
    return { ...base, rows };
  } catch (err) {
    console.warn('[ApifyRotation] reputation preview skipped:', err instanceof Error ? err.message : String(err));
    return base;
  }
}
