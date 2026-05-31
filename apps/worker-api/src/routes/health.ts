// ══════════════════════════════════════════════════════════════
// routes/health.ts
// نکته امنیتی: /health عمومی است — هیچ اطلاعات حساسی expose نمی‌شود
// /status فقط stats کلی نشان می‌دهد
// ══════════════════════════════════════════════════════════════

import type { Env } from '../types';

export async function handleHealth(_req: Request, env: Env): Promise<Response> {
  let dbOk = false;
  try {
    const result = await env.DB.prepare('SELECT 1 as ok').first<{ ok: number }>();
    dbOk = result?.ok === 1;
  } catch { dbOk = false; }

  return Response.json({
    ok: dbOk,
    status: dbOk ? 'healthy' : 'degraded',
    db: dbOk ? 'connected' : 'error',
    environment: env.ENVIRONMENT,
    timestamp: new Date().toISOString(),
  }, { status: dbOk ? 200 : 503 });
}

export async function handleStatus(_req: Request, env: Env): Promise<Response> {
  try {
    const [categories, channels, queuePending] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) as cnt FROM categories WHERE enabled = 1").first<{ cnt: number }>(),
      env.DB.prepare("SELECT COUNT(*) as cnt FROM channels WHERE enabled = 1").first<{ cnt: number }>(),
      env.DB.prepare("SELECT COUNT(*) as cnt FROM publish_queue WHERE status = 'scheduled'").first<{ cnt: number }>(),
    ]);

    // نکته: curation_enabled و publish_enabled اطلاعات داخلی هستند
    // فقط اطلاعات عمومی برگردانیم
    return Response.json({
      ok: true,
      categories: categories?.cnt ?? 0,
      channels: channels?.cnt ?? 0,
      queue_pending: queuePending?.cnt ?? 0,
    });
  } catch {
    return Response.json({ ok: false, error: 'status_unavailable' }, { status: 503 });
  }
}
