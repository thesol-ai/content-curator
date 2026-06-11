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

// 8 cohorts match a 3-hour rotation day: 8 buckets/day.
const VOICES_COHORTS = [
  ['scottmelker'],
  ['rektcapital', 'KoroushAK'],
  ['saylor', 'CryptoCapo_'],
  ['Cobie', 'Ansem'],
  ['Pentosh1', 'HsakaTrades'],
  ['CryptoHayes', 'DegenSpartan'],
  ['DefiIgnas', 'TheDeFinvestor'],
  ['rektfencer', '0xngmi', 'AltcoinDailyio', 'alicharts'],
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
    categoryId: 'crypto',
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

  // Query-first market impact discovery. Cost-neutral: same source ids, cadence, and maxItems.
  // We pass both query and twitterContent because existing Apify task configs use query,
  // while older worker rotation events used twitterContent.
  if (id === 'src_market_trending_x_media') {
    return buildMarketImpactPlan(source, 'media', 24);
  }

  if (id === 'src_market_trending_x_text') {
    return buildMarketImpactPlan(source, 'text', 24);
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
    inputOverride: buildSearchInputOverride(buildTwitterContent(accounts, mode), maxItems),
  };
}

function buildTwitterContent(accounts: string[], mode: RotationMode): string {
  const accountQuery = accounts.map(account => `from:${account}`).join(' OR ');
  const mediaPart = mode === 'media' ? 'filter:media' : '-filter:media';
  return `(${accountQuery}) ${mediaPart} -filter:replies lang:en since:${currentUtcDate()}`;
}

function buildMarketImpactPlan(source: SourceRow, mode: RotationMode, maxItems: number): RotationPlan {
  return {
    source,
    cohortName: `market_impact_${mode}`,
    cohortIndex: null,
    accounts: [],
    inputOverride: buildSearchInputOverride(buildMarketImpactContent(mode), maxItems),
  };
}

function buildMarketImpactContent(mode: RotationMode): string {
  const mediaPart = mode === 'media' ? 'filter:media' : '-filter:media';
  return [
    '(',
    'bitcoin OR BTC OR ethereum OR ETH OR crypto OR stablecoin OR ETF OR "ETF flows" OR',
    'liquidation OR liquidations OR "open interest" OR funding OR onchain OR "rate cut" OR',
    'Fed OR CPI OR inflation OR dollar OR treasury OR "risk off" OR DeFi OR RWA',
    ')',
    mediaPart,
    '-filter:replies',
    'lang:en',
    'min_faves:75',
    `since:${currentUtcDate()}`,
  ].join(' ');
}

function buildSearchInputOverride(query: string, maxItems: number): Record<string, unknown> {
  return {
    query,
    twitterContent: query,
    maxItems,
    queryType: 'Latest',
    lang: 'en',
  };
}

function currentUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
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
