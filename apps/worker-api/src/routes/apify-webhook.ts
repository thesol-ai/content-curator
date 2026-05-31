// ══════════════════════════════════════════════════════════════
// routes/apify-webhook.ts
// دریافت webhook از Apify — سریع acknowledge، async process
// ══════════════════════════════════════════════════════════════

import type { Env } from '../types';
import { runCuration } from '../services/curation-orchestrator';

export async function handleApifyWebhook(
  req: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (req.method !== 'POST') {
    return Response.json({ ok: false, error: 'method_not_allowed' }, { status: 405 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  // Apify webhook در payload یا resource.defaultDatasetId
  const datasetId = body.datasetId ?? body.resource?.defaultDatasetId;
  const actorRunId = body.actorRunId ?? body.resource?.id ?? 'unknown';

  if (!datasetId) {
    return Response.json({ ok: false, error: 'missing datasetId' }, { status: 400 });
  }

  console.log(`[Webhook] Apify run ${actorRunId}, dataset ${datasetId}`);

  // سریع 200 بده — Apify 30 ثانیه timeout دارد
  // پردازش واقعی async با waitUntil
  ctx.waitUntil(
    runCuration(env).then(results => {
      console.log('[Webhook] Curation complete:', results.map(r => ({
        category: r.categoryId,
        platform: r.platform,
        ok: r.ok,
        new: r.itemsNew,
        selected: r.itemsAiSelected,
        queued: r.itemsQueued,
      })));
    }).catch(err => {
      console.error('[Webhook] Curation error:', err);
    })
  );

  return Response.json({
    ok: true,
    message: 'Webhook received, curation started',
    datasetId,
    actorRunId,
  });
}
