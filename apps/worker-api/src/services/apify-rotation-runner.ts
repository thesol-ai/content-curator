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

  const maxSourcesPerTick = options.force || options.dryRun
    ? allPlans.length
    : getMaxSourcesPerTick(env);

  const plans: RotationPlan[] = [];
  for (const plan of allPlans) {
    if (plans.length >= maxSourcesPerTick) break;

    if (options.force || options.dryRun) {
      plans.push(plan);
      continue;
    }

    const claimed = await claimRotationSourceBucket(env, bucket, plan.source.id);
    if (claimed) plans.push(plan);
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
      maxSourcesPerTick,
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
    const attemptResults: NonNullable<ApifyRotationResult['plans'][number]['attempts']> = [];
    let selected: { attempt: RotationAttemptPlan; run: any } | null = null;
    let lastFailure: string | null = null;

    for (const attempt of attempts) {
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
            nextAttemptAvailable: attempts.indexOf(attempt) < attempts.length - 1,
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
      results.push({
        ...resultBase,
        inputOverride: selected.attempt.inputOverride,
        finalAttempt: selected.attempt.attempt,
        attempts: attemptResults,
        actorRunId: safeString(selected.run.id),
        status: safeString(selected.run.status),
        defaultDatasetId: safeString(selected.run.defaultDatasetId),
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

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(inputOverride),
    signal: AbortSignal.timeout((waitForFinish + 10) * 1000),
  });

  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    throw new Error(`Apify task run failed ${response.status}: ${text.slice(0, 500)}`);
  }

  return json?.data ?? json ?? {};
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
