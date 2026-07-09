// ══════════════════════════════════════════════════════════════
// routes/apify-webhook.ts
// دریافت webhook از Apify — سریع acknowledge، async process
//
// اصلاحات v2:
//   ✓ datasetId به runCuration پاس می‌شود — فقط source مطابق پردازش می‌شود
//   ✓ platform از payload استخراج و لاگ می‌شود
//   ✓ webhook secret validation از header هم پشتیبانی می‌کند
// ══════════════════════════════════════════════════════════════

import type { Env } from '../types';
import { runCuration } from '../services/curation-orchestrator';
import { isWebhookDirectCurationEnabled, recordApifyDatasetJob } from '../services/apify-dataset-jobs';

export async function handleApifyWebhook(
  req: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (req.method !== 'POST') {
    return Response.json({ ok: false, error: 'method_not_allowed' }, { status: 405 });
  }

  // Secret validation — از header (امن‌تر) یا query param
  const url = new URL(req.url);
  const sourceId = sanitizeSourceId(url.searchParams.get('source_id') ?? url.searchParams.get('sourceId'));
  const secretFromHeader = req.headers.get('x-webhook-secret');
  const secretFromQuery  = url.searchParams.get('secret');
  const expectedSecret   = env.INTERNAL_API_SECRET;

  if (expectedSecret) {
    const provided = secretFromHeader ?? secretFromQuery;
    if (!provided || provided !== expectedSecret) {
      return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  // Apify webhook در payload یا resource.defaultDatasetId
  const datasetId  = sanitizeDatasetId(body.datasetId ?? body.resource?.defaultDatasetId);
  const actorRunId = body.actorRunId ?? body.resource?.id ?? 'unknown';
  const platform   = body.platform ?? body.meta?.platform ?? 'unknown'; // اگر موجود بود

  if (!datasetId) {
    return Response.json({ ok: false, error: 'missing_or_invalid_datasetId' }, { status: 400 });
  }
  if ((url.searchParams.get('source_id') || url.searchParams.get('sourceId')) && !sourceId) {
    return Response.json({ ok: false, error: 'invalid_source_id' }, { status: 400 });
  }

  console.log(`[Webhook] Apify run=${actorRunId} dataset=${datasetId} source_id=${sourceId ?? 'none'} platform=${platform}`);

  // Always record a durable dataset job when source_id is known.
  // In phase 1, direct curation stays enabled by default, so this is observe-only.
  if (sourceId) {
    ctx.waitUntil(
      recordApifyDatasetJob(env, {
        sourceId,
        datasetId,
        actorRunId: String(actorRunId ?? ''),
        categoryId: undefined,
        platform: platform === 'unknown' ? undefined : String(platform),
      }).then(result => {
        console.log('[Webhook] Dataset job recorded:', { datasetId, sourceId, inserted: result.inserted, jobId: result.id });
      }).catch(err => {
        console.error('[Webhook] Dataset job record error:', err instanceof Error ? err.message : String(err));
      })
    );
  }

  const directCurationEnabled = isWebhookDirectCurationEnabled(env) || !sourceId;

  if (directCurationEnabled) {
    ctx.waitUntil(
      runCuration(env, { datasetId, sourceId: sourceId ?? undefined }, { forceCurationEnabled: true }).then(results => {
        console.log('[Webhook] Curation complete:', results.map(r => ({
          category: r.categoryId,
          platform: r.platform,
          ok: r.ok,
          new: r.itemsNew,
          selected: r.itemsAiSelected,
          queued: r.itemsQueued,
          errors: r.errors.length,
        })));
      }).catch(err => {
        console.error('[Webhook] Curation error:', err instanceof Error ? err.message : String(err));
      })
    );
  } else {
    console.log('[Webhook] Direct curation disabled; dataset job will be processed by scheduler:', { datasetId, sourceId });
  }

  return Response.json({
    ok: true,
    message: directCurationEnabled ? 'Webhook received, curation started' : 'Webhook received, dataset job recorded',
    datasetId,
    actorRunId,
    platform,
    sourceId,
    directCurationEnabled,
  });
}

function sanitizeDatasetId(value: unknown): string | null {
  const v = String(value ?? '').trim();
  return /^[A-Za-z0-9]{8,40}$/.test(v) ? v : null;
}

function sanitizeSourceId(value: unknown): string | null {
  const v = String(value ?? '').trim();
  return /^[\w-]{1,64}$/.test(v) ? v : null;
}
