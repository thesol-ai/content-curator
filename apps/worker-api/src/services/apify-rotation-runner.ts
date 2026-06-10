import type { Env } from '../types';
import { recordRunEvent } from './run-events';

const APIFY_API_BASE = 'https://api.apify.com/v2';

const ROTATION_SOURCE_IDS = new Set([
  'src_crypto_x_news_media',
  'src_crypto_x_news_text',
  'src_crypto_x_voices_media',
  'src_crypto_x_voices_text',
  'src_market_trending_x_media',
  'src_market_trending_x_text',
]);

const NEWS_COHORTS = [
  ['cointelegraph'],
  ['coindesk'],
  ['Utoday_en'],
  ['beincrypto'],
  ['bitcoinmagazine'],
  ['blockworks'],
  ['decryptmedia'],
];

const VOICES_COHORTS = [
  ['rektcapital'],
  ['scottmelker'],
  ['KoroushAK'],
  ['saylor'],
  ['CryptoCapo_'],
  ['Cobie'],
  ['Pentosh1'],
  ['HsakaTrades'],
  ['Ansem'],
  ['CryptoHayes'],
  ['DegenSpartan'],
  ['DefiIgnas'],
  ['TheDeFinvestor'],
  ['rektfencer'],
  ['0xngmi'],
  ['AltcoinDailyio'],
  ['alicharts'],
];

type RotationMode = 'media' | 'text' | 'default';

interface SourceRow {
  id: string;
  label: string | null;
  category_id: string;
  platform: string;
  apify_task_id: string | null;
}

interface RotationPlan {
  source: SourceRow;
  cohortName: string;
  cohortIndex: number | null;
  accounts: string[];
  inputOverride: Record<string, unknown>;
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

  if (!options.force) {
    const claimed = await claimRotationBucket(env, bucket);
    if (!claimed) {
      return {
        ok: true,
        skipped: true,
        reason: 'rotation_bucket_already_claimed',
        bucket,
        rotationRunId,
        plans: [],
      };
    }
  }

  const sources = await loadRotationSources(env, options.onlySourceId);
  const plans = sources
    .map(source => buildRotationPlan(source, bucket))
    .filter((plan): plan is RotationPlan => Boolean(plan));

  await recordRunEvent(env, {
    runId: rotationRunId,
    eventType: 'apify.rotation.started',
    phase: 'apify_rotation',
    categoryId: 'crypto',
    metadata: {
      bucket,
      intervalHours,
      dryRun: options.dryRun === true,
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

    try {
      const run = await runApifyTask(env, taskId, plan.inputOverride);
      results.push({
        ...resultBase,
        actorRunId: safeString(run.id),
        status: safeString(run.status),
        defaultDatasetId: safeString(run.defaultDatasetId),
      });

      await recordRunEvent(env, {
        runId: rotationRunId,
        eventType: 'apify.rotation.task_started',
        phase: 'apify_rotation',
        categoryId: plan.source.category_id,
        platform: plan.source.platform,
        sourceId: plan.source.id,
        datasetId: safeString(run.defaultDatasetId) ?? undefined,
        actorRunId: safeString(run.id) ?? undefined,
        durationMs: Date.now() - started,
        metadata: {
          bucket,
          cohortName: plan.cohortName,
          cohortIndex: plan.cohortIndex,
          accounts: plan.accounts,
          inputOverride: plan.inputOverride,
          status: safeString(run.status),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ ...resultBase, error: message });

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
          cohortName: plan.cohortName,
          cohortIndex: plan.cohortIndex,
          accounts: plan.accounts,
        },
      });
    }
  }

  const ok = results.every(row => !row.error);

  await recordRunEvent(env, {
    runId: rotationRunId,
    eventType: ok ? 'apify.rotation.completed' : 'apify.rotation.completed_with_errors',
    phase: 'apify_rotation',
    severity: ok ? 'info' : 'warn',
    categoryId: 'crypto',
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
  const id = source.id;

  if (id === 'src_crypto_x_news_media') {
    return buildCohortPlan(source, NEWS_COHORTS, bucket + 3, 'news', 'media', 24);
  }

  if (id === 'src_crypto_x_news_text') {
    return buildCohortPlan(source, NEWS_COHORTS, bucket, 'news', 'text', 24);
  }

  if (id === 'src_crypto_x_voices_media') {
    return buildCohortPlan(source, VOICES_COHORTS, bucket + 8, 'voices', 'media', 24);
  }

  if (id === 'src_crypto_x_voices_text') {
    return buildCohortPlan(source, VOICES_COHORTS, bucket, 'voices', 'text', 24);
  }

  // فعلاً market را حذف یا کم نمی‌کنیم، چون runway پایین است.
  // اما market هنوز با input پیش‌فرض task اجرا می‌شود.
  if (id === 'src_market_trending_x_media' || id === 'src_market_trending_x_text') {
    return {
      source,
      cohortName: 'market_default',
      cohortIndex: null,
      accounts: [],
      inputOverride: {},
    };
  }

  return null;
}

function buildCohortPlan(
  source: SourceRow,
  cohorts: string[][],
  bucket: number,
  family: string,
  mode: RotationMode,
  maxItems: number,
): RotationPlan {
  const index = positiveModulo(bucket, cohorts.length);
  const accounts = cohorts[index] ?? cohorts[0]!;
  return {
    source,
    cohortName: `${family}_${mode}_${index}`,
    cohortIndex: index,
    accounts,
    inputOverride: {
      twitterContent: buildTwitterContent(accounts, mode),
      maxItems,
    },
  };
}

function buildTwitterContent(accounts: string[], mode: RotationMode): string {
  const accountQuery = accounts.map(account => `from:${account}`).join(' OR ');
  const mediaPart = mode === 'media' ? 'filter:media' : '-filter:media';
  return `(${accountQuery}) ${mediaPart} -filter:replies`;
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
    WHERE category_id='crypto'
      AND enabled=1
    ORDER BY id
  `).all<SourceRow>();

  return (rows.results ?? [])
    .filter(row => ROTATION_SOURCE_IDS.has(row.id))
    .filter(row => !onlySourceId || row.id === onlySourceId);
}

async function claimRotationBucket(env: Env, bucket: number): Promise<boolean> {
  const key = 'apify_rotation_last_bucket_crypto';
  const value = String(bucket);

  const current = await env.DB
    .prepare('SELECT value FROM settings WHERE key=?')
    .bind(key)
    .first<{ value: string }>();

  if (current?.value === value) return false;

  await env.DB.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value=excluded.value,
      updated_at=CURRENT_TIMESTAMP
  `).bind(key, value).run();

  return true;
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

function positiveModulo(value: number, size: number): number {
  return ((value % size) + size) % size;
}

function safeString(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text ? text : null;
}

function makeRotationRunId(): string {
  return `apify_rotation_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
