// ══════════════════════════════════════════════════════════════
// routes/admin.ts — Admin API
// نکات امنیتی:
// - همه /internal/* نیاز به x-internal-api-secret دارند (در index.ts چک می‌شود)
// - path segment‌ها sanitize می‌شوند
// - SQL همیشه parameterized است
// ══════════════════════════════════════════════════════════════

import type { Env, ChannelRow } from '../types';
import { publishDueItems, publishQueueItem, runCuration } from '../services/curation-orchestrator';
import { getStreamTranscodeState } from '../services/stream-config';
import { getRuntimeConfig } from '../services/runtime-config';
import { prepareTelegramCaptions } from '../services/telegram-publisher';
import { sanitizeRunDebugId } from '../services/run-events';
import { buildMarketSnapshotText, sendMarketSnapshotDirect } from '../services/market-snapshot';
import { buildOperationalReport } from '../services/operational-report';
import { formatOperationalReportForTelegram } from '../services/report-message-formatter';
import { buildQueueHealthReport } from '../services/queue-health';
import { buildRejectionFunnel } from '../services/rejection-funnel';
import { buildSourcePerformanceReport } from '../services/source-reputation';
import { buildStoryStabilityReport } from '../services/story-intelligence';
import {
  buildQueueQualityReport,
  buildSourceYieldReport,
  buildTopicMixReport,
  buildSourceCapPreview,
  buildAiCostBySourceReport,
  buildApifyQueryYieldReport,
  buildGapFillPreview,
} from '../services/observability-reports';
import { drainAICandidateQueue } from '../services/backlog-drain';
import { buildSourceReputationPreview, runApifyRotation } from '../services/apify-rotation-runner';
import {
  getCandidateBacklogDrainLimit,
  getCandidateMaxAgeHours,
  getCandidateQueueStats,
  getMaxCandidateAttempts,
  getMaxScoringBatchesPerRun,
  getScoringBatchSize,
  isCandidateBacklogEnabled,
  isFairSourcePickerEnabled,
} from '../services/candidate-queue';

// ID validation — فقط alphanumeric و underscore و dash
function isValidId(id: string | undefined): id is string {
  return typeof id === 'string' && /^[\w-]{1,64}$/.test(id);
}

function sanitizeDebugId(value: string | null, fallback: string): string {
  const raw = String(value ?? '').trim();
  return /^[\w-]{1,64}$/.test(raw) ? raw : fallback;
}

function sanitizeOptionalId(value: string | null): string | undefined {
  const raw = String(value ?? '').trim();
  return /^[\w-]{1,64}$/.test(raw) ? raw : undefined;
}

// Path segment safe extraction
function pathSegment(path: string, index: number): string | undefined {
  const parts = path.split('/').filter(Boolean);
  return parts[index];
}

export async function handleAdmin(
  req: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const url  = new URL(req.url);
  const path = url.pathname;
  const m    = req.method;

  try {
    // ── Discovery runs ────────────────────────────────────────
    if (path === '/internal/runs' && m === 'GET') {
      return listRuns(env, url);
    }

    // ── Discovery items ───────────────────────────────────────
    if (path === '/internal/items' && m === 'GET') {
      return listItems(env, url);
    }

    // ── Publish queue list ────────────────────────────────────
    if (path === '/internal/queue' && m === 'GET') {
      return listQueue(env, url);
    }

    // ── Manual publish due queue items ────────────────────────
    if (path === '/internal/publish/due' && m === 'POST') {
      return triggerPublishDue(req, env);
    }

    // ── AI candidate backlog controls (feature-flagged) ─────────
    if (path === '/internal/backlog/stats' && m === 'GET') {
      return getBacklogStats(env);
    }

    if (path === '/internal/backlog/drain' && m === 'POST') {
      return triggerBacklogDrain(req, env);
    }

    // ── Market snapshot preview/enqueue ─────────────────────────
    if (path === '/internal/market-snapshot/preview' && m === 'GET') {
      try {
        const text = await buildMarketSnapshotText(env);
        return ok({ text });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ ok: false, error: 'market_snapshot_preview_failed', message }, { status: 500 });
      }
    }

    if (path === '/internal/market-snapshot/enqueue' && m === 'POST') {
      return Response.json(
        { ok: false, error: 'market_snapshot_queue_disabled', message: 'Market snapshot is sent directly and no longer uses publish_queue.' },
        { status: 410 }
      );
    }

    if (path === '/internal/market-snapshot/send-now' && m === 'POST') {
      const body: any = await req.json().catch(() => ({}));
      const channelId = typeof body.channel_id === 'string' ? body.channel_id : 'crypto_fa_pilot';
      const force = body.force === true || body.force === 'true';
      const result = await sendMarketSnapshotDirect(env, channelId, force);
      return ok(result);
    }

    // ── Preview one queue item with the real Telegram formatter ─
    if (path.startsWith('/internal/queue/') && path.endsWith('/preview') && m === 'GET') {
      const queueId = pathSegment(path, 2);
      if (!isValidId(queueId)) return err('invalid queue id', 400);
      return previewQueueItem(env, queueId);
    }

    // ── Publish one queue item immediately ────────────────────
    if (path.startsWith('/internal/queue/') && path.endsWith('/publish-now') && m === 'POST') {
      const queueId = pathSegment(path, 2);
      if (!isValidId(queueId)) return err('invalid queue id', 400);
      return publishQueueItemNow(env, queueId);
    }

    // ── Media diagnostics ────────────────────────────────────
    if (path === '/internal/media' && m === 'GET') {
      return listMedia(env, url);
    }

    // ── Cancel queue item ─────────────────────────────────────
    if (path.startsWith('/internal/queue/') && !path.endsWith('/retry') && m === 'DELETE') {
      const queueId = pathSegment(path, 2);
      if (!isValidId(queueId)) return err('invalid queue id', 400);
      const result = await env.DB
        .prepare("UPDATE publish_queue SET status='cancelled' WHERE id=? AND status IN ('scheduled','retry','failed')")
        .bind(queueId).run();
      return ok({ cancelled: queueId, affected: result.meta.changes ?? 0 });
    }

    // ── Retry a failed queue item ─────────────────────────────
    if (path.startsWith('/internal/queue/') && path.endsWith('/retry') && m === 'POST') {
      const queueId = pathSegment(path, 2); // /internal/queue/{id}/retry
      if (!isValidId(queueId)) return err('invalid queue id', 400);
      const now = Math.floor(Date.now() / 1000);
      const result = await env.DB
        .prepare("UPDATE publish_queue SET status='scheduled', retry_count=0, scheduled_at=?, publish_error=NULL WHERE id=? AND status IN ('failed','retry')")
        .bind(now + 60, queueId).run();
      return ok({ retried: queueId, affected: result.meta.changes ?? 0 });
    }

    // ── Apify controlled rotation trigger ─────────────────────
    if ((path === '/internal/apify/rotation/run' || path === '/internal/apify-rotation/run') && m === 'POST') {
      const body: any = await req.json().catch(() => ({}));
      const result = await runApifyRotation(env, {
        force: body.force === true || body.force === 'true',
        dryRun: body.dryRun === true || body.dry_run === true || body.dryRun === 'true' || body.dry_run === 'true',
        onlySourceId: typeof body.onlySourceId === 'string' ? body.onlySourceId : undefined,
      });
      return ok(result);
    }

    // ── Curation trigger ──────────────────────────────────────
    if (path === '/internal/curation/trigger' && m === 'POST') {
      return triggerCuration(req, env);
    }

    // ── Settings toggle ───────────────────────────────────────
    if (path === '/internal/admin/toggle' && m === 'POST') {
      return toggleSetting(req, env);
    }

    // ── Settings list ─────────────────────────────────────────
    if (path === '/internal/admin/settings' && m === 'GET') {
      const rows = await env.DB.prepare('SELECT key, value, updated_at FROM settings').all();
      return ok({ settings: rows.results ?? [] });
    }


    // ── Full operational report for Telegram/admin dashboard (read-only) ──
    if (path === '/internal/report/ops' && m === 'GET') {
      return ok(await buildOperationalReport(env, url));
    }

    // ── Telegram-ready operational report preview (read-only) ─────────────
    if (path === '/internal/report/ops/telegram-preview' && m === 'GET') {
      const report = await buildOperationalReport(env, url);
      return ok({
        parse_mode: 'HTML',
        text: formatOperationalReportForTelegram(report as any),
      });
    }

    // ── Queue-health report (read-only, Phase 6E) ─────────────
    if (path === '/internal/report/queue-health' && m === 'GET') {
      const categoryId = sanitizeOptionalId(url.searchParams.get('category'));
      return ok(await buildQueueHealthReport(env, categoryId));
    }

    // ── Rejection funnel "why is the queue empty?" (read-only, Phase 6E) ─
    if (path === '/internal/report/funnel' && m === 'GET') {
      const categoryId = sanitizeOptionalId(url.searchParams.get('category'));
      const windowHours = num(url.searchParams.get('hours'), 24);
      return ok(await buildRejectionFunnel(env, { categoryId, windowHours }));
    }

    // ── Source performance + reputation (read-only, Phase 6I observe) ─────
    if (path === '/internal/report/source-performance' && m === 'GET') {
      const categoryId = sanitizeOptionalId(url.searchParams.get('category'));
      const windowHours = num(url.searchParams.get('hours'), 48);
      return ok(await buildSourcePerformanceReport(env, { categoryId, windowHours }));
    }

    // ── Story-intelligence stability (read-only, Phase 6K observe) ─────────
    if (path === '/internal/report/story-intelligence' && m === 'GET') {
      const categoryId = sanitizeOptionalId(url.searchParams.get('category'));
      const windowHours = num(url.searchParams.get('hours'), 72);
      return ok(await buildStoryStabilityReport(env, { categoryId, windowHours }));
    }

    // ── Queue QUALITY/diversity (read-only) ───────────────────────────────
    if (path === '/internal/report/queue-quality' && m === 'GET') {
      const channelId = sanitizeOptionalId(url.searchParams.get('channel'))
        || (env as any).QUEUE_HEALTH_CHANNEL_ID?.trim() || 'crypto_fa_pilot';
      return ok(await buildQueueQualityReport(env, channelId));
    }

    // ── Source YIELD per account (read-only) ──────────────────────────────
    if (path === '/internal/report/source-yield' && m === 'GET') {
      const categoryId = sanitizeOptionalId(url.searchParams.get('category'));
      const windowHours = num(url.searchParams.get('hours'), 48);
      return ok(await buildSourceYieldReport(env, { categoryId, windowHours }));
    }

    // ── Topic MIX of published output (read-only) ─────────────────────────
    if (path === '/internal/report/topic-mix' && m === 'GET') {
      const categoryId = sanitizeOptionalId(url.searchParams.get('category'));
      const windowHours = num(url.searchParams.get('hours'), 48);
      return ok(await buildTopicMixReport(env, { categoryId, windowHours }));
    }

    // ── Source daily-cap PREVIEW (report-only; what WOULD be capped) ───────
    if (path === '/internal/report/source-cap-preview' && m === 'GET') {
      const channelId = sanitizeOptionalId(url.searchParams.get('channel'))
        || (env as any).QUEUE_HEALTH_CHANNEL_ID?.trim() || 'crypto_fa_pilot';
      return ok(await buildSourceCapPreview(env, channelId));
    }

    // ── AI cost attribution by source (needs migration 0019 + flag) ───────
    if (path === '/internal/report/ai-cost-by-source' && m === 'GET') {
      const categoryId = sanitizeOptionalId(url.searchParams.get('category'));
      const windowHours = num(url.searchParams.get('hours'), 72);
      return ok(await buildAiCostBySourceReport(env, { categoryId, windowHours }));
    }

    // ── Apify/source query yield (fetched→rejected→published per source) ──
    if (path === '/internal/report/apify-query-yield' && m === 'GET') {
      const categoryId = sanitizeOptionalId(url.searchParams.get('category'));
      const windowHours = num(url.searchParams.get('hours'), 72);
      return ok(await buildApifyQueryYieldReport(env, { categoryId, windowHours }));
    }

    // ── Gap-fill PREVIEW (report-only; current vs backloaded) ─────────────
    if (path === '/internal/report/gap-fill-preview' && m === 'GET') {
      const channelId = sanitizeOptionalId(url.searchParams.get('channel'))
        || (env as any).QUEUE_HEALTH_CHANNEL_ID?.trim() || 'crypto_fa_pilot';
      return ok(await buildGapFillPreview(env, channelId));
    }

    // ── Source reputation-weighting PREVIEW (read-only; what weighting WOULD do) ─
    if (path === '/internal/report/source-reputation-preview' && m === 'GET') {
      return ok(await buildSourceReputationPreview(env));
    }

    // ── Daily operational report (read-only) ───────────────────
    if (path === '/internal/report/daily' && m === 'GET') {
      return getDailyReport(env, url);
    }

    // ── Market trending experiment report (read-only) ──────────
    if (path === '/internal/report/market-trending' && m === 'GET') {
      return getMarketTrendingReport(env, url);
    }

    // ── Crypto pipeline debug snapshot (read-only) ─────────────
    if (path === '/internal/debug/crypto-pipeline' && m === 'GET') {
      return getCryptoPipelineDebug(env, url);
    }

    // ── Run control event logs (read-only) ─────────────────────
    if (path.startsWith('/internal/debug/runs/') && path.endsWith('/events') && m === 'GET') {
      const runId = sanitizeRunDebugId(pathSegment(path, 3)); // /internal/debug/runs/{runId}/events
      if (!runId) return err('invalid run id', 400);
      return listRunEvents(env, url, runId);
    }

    if (path.startsWith('/internal/debug/runs/') && path.endsWith('/items') && m === 'GET') {
      const runId = sanitizeRunDebugId(pathSegment(path, 3)); // /internal/debug/runs/{runId}/items
      if (!runId) return err('invalid run id', 400);
      return listRunItemEvents(env, url, runId);
    }

    // ── Debug repair for stale processing discovery runs ───────
    if (path.startsWith('/internal/debug/discovery-runs/') && path.endsWith('/mark-failed') && m === 'POST') {
      const runId = pathSegment(path, 3); // /internal/debug/discovery-runs/{id}/mark-failed
      if (!isValidId(runId)) return err('invalid discovery run id', 400);
      return markDiscoveryRunFailedForDebug(req, env, runId);
    }

    // ── Stats ─────────────────────────────────────────────────
    if (path === '/internal/stats' && m === 'GET') {
      return getStats(env);
    }

    // ── Categories ────────────────────────────────────────────
    if (path === '/internal/categories' && m === 'GET') {
      const r = await env.DB.prepare('SELECT * FROM categories ORDER BY id').all();
      return ok({ categories: r.results ?? [] });
    }

    if (path === '/internal/categories' && m === 'POST') {
      return createCategory(req, env);
    }

    if (path.startsWith('/internal/categories/') && m === 'PATCH') {
      const id = pathSegment(path, 2); // /internal/categories/{id}
      if (!isValidId(id)) return err('invalid category id', 400);
      return updateCategory(req, env, id);
    }

    // ── Channels ──────────────────────────────────────────────
    if (path === '/internal/channels' && m === 'GET') {
      const category = url.searchParams.get('category');
      const q = category && isValidId(category)
        ? env.DB.prepare('SELECT * FROM channels WHERE category_id=? ORDER BY language').bind(category)
        : env.DB.prepare('SELECT * FROM channels ORDER BY category_id, language');
      const r = await q.all();
      return ok({ channels: r.results ?? [] });
    }

    if (path === '/internal/channels' && m === 'POST') {
      return createChannel(req, env);
    }

    if (path.startsWith('/internal/channels/') && !path.endsWith('/publish') && m === 'PATCH') {
      const id = pathSegment(path, 2);
      if (!isValidId(id)) return err('invalid channel id', 400);
      return updateChannel(req, env, id);
    }

    if (path.startsWith('/internal/channels/') && path.endsWith('/publish') && m === 'POST') {
      const id = pathSegment(path, 2);
      if (!isValidId(id)) return err('invalid channel id', 400);
      const body: any = await req.json().catch(() => ({}));
      const enable = body.enabled === true || body.enabled === 'true';
      await env.DB
        .prepare('UPDATE channels SET publish_enabled=? WHERE id=?')
        .bind(enable ? 1 : 0, id).run();
      return ok({ channelId: id, publishEnabled: enable });
    }

    // ── Source accounts ───────────────────────────────────────
    if (path === '/internal/source-accounts' && m === 'GET') {
      const category = url.searchParams.get('category');
      const q = category && isValidId(category)
        ? env.DB.prepare('SELECT * FROM source_accounts WHERE category_id=? ORDER BY platform, account_handle').bind(category)
        : env.DB.prepare('SELECT * FROM source_accounts ORDER BY category_id, platform');
      const r = await q.all();
      return ok({ accounts: r.results ?? [] });
    }

    if (path === '/internal/source-accounts' && m === 'POST') {
      return createSourceAccount(req, env);
    }

    if (path.startsWith('/internal/source-accounts/') && m === 'DELETE') {
      const id = pathSegment(path, 2);
      if (!isValidId(id)) return err('invalid id', 400);
      await env.DB.prepare('UPDATE source_accounts SET enabled=0 WHERE id=?').bind(id).run();
      return ok({ disabled: id });
    }

    // ── Apify sources ─────────────────────────────────────────
    if (path === '/internal/apify-sources' && m === 'GET') {
      const r = await env.DB.prepare('SELECT * FROM apify_sources ORDER BY category_id, platform').all();
      return ok({ sources: r.results ?? [] });
    }

    if (path === '/internal/apify-sources' && m === 'POST') {
      return createApifySource(req, env);
    }

    if (path.startsWith('/internal/apify-sources/') && m === 'PATCH') {
      const id = pathSegment(path, 2);
      if (!isValidId(id)) return err('invalid id', 400);
      return updateApifySource(req, env, id);
    }

    if (path.startsWith('/internal/apify-sources/') && m === 'DELETE') {
      const id = pathSegment(path, 2);
      if (!isValidId(id)) return err('invalid id', 400);
      await env.DB.prepare('DELETE FROM apify_sources WHERE id=?').bind(id).run();
      return ok({ deleted: id });
    }

    return err('not_found', 404);

  } catch (e) {
    console.error('[Admin]', path, e);
    // هرگز error details را به client نفرستید
    return err('internal_server_error', 500);
  }
}

// ── Handlers ──────────────────────────────────────────────────

async function listRuns(env: Env, url: URL): Promise<Response> {
  const limit    = clamp(num(url.searchParams.get('limit'), 20), 1, 100);
  const category = url.searchParams.get('category');
  const q = (category && isValidId(category))
    ? env.DB.prepare('SELECT * FROM discovery_runs WHERE category_id=? ORDER BY created_at DESC LIMIT ?').bind(category, limit)
    : env.DB.prepare('SELECT * FROM discovery_runs ORDER BY created_at DESC LIMIT ?').bind(limit);
  const r = await q.all();
  return ok({ runs: r.results ?? [] });
}

async function listItems(env: Env, url: URL): Promise<Response> {
  const VALID_STATUSES = ['pending','ai_processing','ai_selected','ai_rejected','queued','duplicate','error'];
  const rawStatus = url.searchParams.get('status') ?? 'ai_selected';
  const status = VALID_STATUSES.includes(rawStatus) ? rawStatus : 'ai_selected';
  const category = url.searchParams.get('category');
  const platform = url.searchParams.get('platform');
  const limit = clamp(num(url.searchParams.get('limit'), 50), 1, 200);

  let q = 'SELECT id,run_id,category_id,platform,source_account,source_url,ai_score,ai_risk,ai_priority,risk_flags,status,reject_reason,created_at,text,media_count,media_expected_count,media_extracted_count,media_extraction_warnings,is_reply,is_retweet,is_quote FROM discovery_items WHERE status=?';
  const params: any[] = [status];

  if (category && isValidId(category)) { q += ' AND category_id=?'; params.push(category); }
  if (platform && /^[a-z]{1,20}$/.test(platform)) { q += ' AND platform=?'; params.push(platform); }
  q += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const r = await env.DB.prepare(q).bind(...params).all();
  return ok({ items: r.results ?? [] });
}

async function listQueue(env: Env, url: URL): Promise<Response> {
  const VALID_STATUSES = ['scheduled','publishing','published','failed','retry','cancelled','manual_hold'];
  const rawStatus = url.searchParams.get('status') ?? 'scheduled';
  const status = VALID_STATUSES.includes(rawStatus) ? rawStatus : 'scheduled';
  const channelId = url.searchParams.get('channel');
  const limit = clamp(num(url.searchParams.get('limit'), 50), 1, 200);

  // caption_full عمداً حذف شده (privacy + performance — در detail view می‌آید)
  let q = 'SELECT id,item_id,channel_id,language,source_url,caption_short,telegram_method,media_urls,media_warning,all_message_ids,scheduled_at,status,retry_count,publish_error,published_at,created_at FROM publish_queue WHERE status=?';
  const params: any[] = [status];

  if (channelId && isValidId(channelId)) { q += ' AND channel_id=?'; params.push(channelId); }
  q += ' ORDER BY scheduled_at ASC LIMIT ?';
  params.push(limit);

  const r = await env.DB.prepare(q).bind(...params).all();
  return ok({ queue: r.results ?? [] });
}


async function previewQueueItem(env: Env, queueId: string): Promise<Response> {
  const row = await env.DB
    .prepare('SELECT * FROM publish_queue WHERE id=?')
    .bind(queueId)
    .first<any>();

  if (!row) return err('queue_item_not_found', 404);

  // Preview should work for paused channels too. Publish still enforces enabled/publish_enabled.
  const channel = await env.DB
    .prepare('SELECT * FROM channels WHERE id=?')
    .bind(row.channel_id)
    .first<ChannelRow>();

  if (!channel) return err('channel_not_found', 404);

  const mediaUrls: string[] = safeJsonParse(row.media_urls, []);
  const thumbnailUrls: string[] = safeJsonParse(row.thumbnail_urls, []);
  const mediaTypes: Array<'image' | 'video'> = safeJsonParse(row.media_types, []);

  const captions = prepareTelegramCaptions({
    chatId: channel.telegram_chat_id,
    captionShort: row.caption_short ?? '',
    captionFull: row.caption_full ?? '',
    sourceUrl: row.source_url ?? '',
    method: row.telegram_method ?? 'sendMessage',
    language: row.language ?? channel.language,
    channel,
    mediaUrls,
    thumbnailUrls,
    mediaTypes,
  });

  const warnings: string[] = [];
  if (captions.fullHtml.length > 4096) warnings.push('full_caption_exceeds_telegram_message_limit');
  if (captions.mediaHtml.length > 1024) warnings.push('media_caption_exceeds_telegram_caption_limit');
  if (captions.sendFullFollowUp) warnings.push('full_caption_will_be_sent_as_follow_up_message');

  const rawSourceVisible = isRawSourceVisible(captions.fullHtml, row.source_url ?? '')
    || isRawSourceVisible(captions.mediaHtml, row.source_url ?? '');
  if (rawSourceVisible) warnings.push('raw_source_url_visible');

  return ok({
    queueId,
    itemId: row.item_id,
    channelId: row.channel_id,
    status: row.status,
    method: row.telegram_method ?? 'sendMessage',
    language: row.language ?? channel.language,
    sourceUrl: row.source_url ?? '',
    channel: {
      id: channel.id,
      label: channel.channel_label ?? null,
      telegram_chat_id: channel.telegram_chat_id,
      publish_enabled: channel.publish_enabled,
      enabled: channel.enabled,
      source_enabled: channel.source_enabled,
      signature_enabled: channel.signature_enabled,
      channel_id_footer_enabled: channel.channel_id_footer_enabled,
      disable_link_preview: channel.disable_link_preview,
    },
    formatting: {
      source_visible: /<a\s+href=/i.test(captions.fullHtml),
      signature_configured: isTruthy(channel.signature_enabled) && Boolean(String(channel.signature_text ?? '').trim()),
      channel_footer_configured: isTruthy(channel.channel_id_footer_enabled),
      disable_link_preview: channel.disable_link_preview !== 0,
      full_truncated: captions.fullTruncated ?? false,
      short_truncated: captions.shortTruncated ?? false,
      full_footer_included: captions.fullFooterIncluded ?? false,
      short_footer_included: captions.shortFooterIncluded ?? false,
      full_footer_omitted: captions.fullFooterOmitted ?? false,
      short_footer_omitted: captions.shortFooterOmitted ?? false,
    },
    captions: {
      full_html: captions.fullHtml,
      short_html: captions.shortHtml,
      media_html: captions.mediaHtml,
      send_full_follow_up: captions.sendFullFollowUp,
      full_length: captions.fullHtml.length,
      short_length: captions.shortHtml.length,
      media_length: captions.mediaHtml.length,
    },
    telegram_preview: buildTelegramPreviewPayload(row.telegram_method ?? 'sendMessage', channel.telegram_chat_id, captions, mediaUrls, mediaTypes),
    media: {
      count: mediaUrls.length,
      urls: mediaUrls,
      thumbnail_urls: thumbnailUrls,
      types: mediaTypes,
    },
    warnings,
  });
}

async function listMedia(env: Env, url: URL): Promise<Response> {
  const itemId = url.searchParams.get('item');
  const status = url.searchParams.get('status');
  const limit = clamp(num(url.searchParams.get('limit'), 100), 1, 300);

  const params: any[] = [];
  let q = `
    SELECT id,item_id,media_index,media_type,source_url,thumbnail_url,mime_type,file_size_bytes,
           width,height,duration_sec,size_mb,processing_status,processing_error,expires_at,
           telegram_file_id,telegram_message_id,thumbnail_status,thumbnail_error,validated_at,created_at
    FROM discovery_media
    WHERE 1=1
  `;

  if (itemId && isValidId(itemId)) { q += ' AND item_id=?'; params.push(itemId); }
  if (status && /^[a-z_]{1,32}$/.test(status)) { q += ' AND processing_status=?'; params.push(status); }
  q += ' ORDER BY created_at DESC, media_index ASC LIMIT ?';
  params.push(limit);

  const rows = await env.DB.prepare(q).bind(...params).all();
  return ok({ media: rows.results ?? [] });
}

async function triggerCuration(req: Request, env: Env): Promise<Response> {
  let body: any = {};
  try { body = await req.json(); } catch { /* no body */ }

  const rawSourceId = body.source_id ?? body.sourceId;
  const rawDatasetId = body.dataset_id ?? body.datasetId;
  const rawCategoryId = body.category_id ?? body.categoryId;

  const sourceId = typeof rawSourceId === 'string' && isValidId(rawSourceId) ? rawSourceId : undefined;
  const datasetId = typeof rawDatasetId === 'string' ? sanitizeApifyDatasetId(rawDatasetId) ?? undefined : undefined;
  const categoryId = typeof rawCategoryId === 'string' && isValidId(rawCategoryId) ? rawCategoryId : undefined;

  const scope = {
    ...(sourceId ? { sourceId } : {}),
    ...(datasetId ? { datasetId } : {}),
    ...(categoryId ? { categoryId } : {}),
  };

  const results = await runCuration(env, Object.keys(scope).length > 0 ? scope : undefined, {
    forceCurationEnabled: body.force === true,
    curationDryRun: typeof body.dryRun === 'boolean' ? body.dryRun : undefined,
  });
  return ok({ triggered: true, scope, runs: results });
}

async function triggerPublishDue(req: Request, env: Env): Promise<Response> {
  const body: any = await req.json().catch(() => ({}));
  const limit = body?.limit === undefined
    ? undefined
    : clamp(num(String(body.limit), 3), 1, 100);

  // Manual QA endpoint bypasses only the scheduler flag. It still uses the same
  // queue/publisher path and Telegram publish remains protected by the env+DB
  // kill switches in publishToTelegram/runtime-config.
  const result = await publishDueItems(env, { limit, requireScheduler: false });
  return ok(result);
}

async function publishQueueItemNow(env: Env, queueId: string): Promise<Response> {
  const result = await publishQueueItem(env, queueId, {
    allowedStatuses: ['scheduled', 'retry', 'failed'],
    bypassSchedule: true,
    respectRateLimits: true,
  });
  return ok({
    queueId,
    published: result.status === 'published',
    status: result.status,
    reason: result.reason ?? null,
    telegramMessageId: result.telegramMessageId ?? null,
    allMessageIds: result.allMessageIds ?? [],
    error: result.error ?? null,
  });
}

async function toggleSetting(req: Request, env: Env): Promise<Response> {
  const body: any = await req.json().catch(() => null);
  if (!body?.key) return err('missing key', 400);

  const ALLOWED_KEYS = new Set([
    'telegram_publish_enabled',
    'apify_curation_enabled',
    'apify_curation_dry_run',
    'maintenance_mode',
  ]);
  if (!ALLOWED_KEYS.has(body.key)) return err('key_not_allowed', 400);

  // value باید boolean string باشد
  const value = body.value === true || body.value === 'true' ? 'true' : 'false';

  await env.DB
    .prepare("INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)")
    .bind(body.key, value).run();

  return ok({ key: body.key, value });
}

async function createCategory(req: Request, env: Env): Promise<Response> {
  const body: any = await req.json().catch(() => null);
  if (!body?.id || !body?.label || !body?.prompt_profile) {
    return err('missing id, label or prompt_profile', 400);
  }

  // ID validation
  if (!isValidId(body.id)) return err('invalid id format', 400);

  // validate media_mode
  const validMediaModes = ['optional', 'preferred', 'disabled'];
  const mediaMode = validMediaModes.includes(body.media_mode) ? body.media_mode : 'optional';

  // validate language_targets
  let langTargets = '["fa"]';
  if (Array.isArray(body.language_targets)) {
    const valid = body.language_targets.filter((l: any) => typeof l === 'string' && /^[a-z]{2}$/.test(l));
    langTargets = JSON.stringify(valid.length ? valid : ['fa']);
  } else if (typeof body.language_targets === 'string') {
    try { langTargets = JSON.stringify(JSON.parse(body.language_targets)); } catch { /* use default */ }
  }

  const categoryValidationError = validateCategoryEditorialInput(body);
  if (categoryValidationError) return err(categoryValidationError, 400);

  await env.DB.prepare(`
    INSERT OR IGNORE INTO categories
    (id, label, prompt_profile, custom_prompt, score_threshold, freshness_hours, media_mode, language_targets,
     editorial_guidelines, selection_criteria, rejection_criteria, required_context, avoid_duplicate_people_stories,
     allow_replies, allow_retweets, allow_quotes, text_only_policy, min_score_for_text_only, min_score_for_media,
     enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).bind(
    body.id,
    String(body.label).slice(0, 100),
    String(body.prompt_profile).slice(0, 100),
    sanitizeLongText(body.custom_prompt, 4000),
    clamp(Number(body.score_threshold) || 75, 0, 100),
    Math.max(1, Number(body.freshness_hours) || 48),
    mediaMode,
    langTargets,
    sanitizeLongText(body.editorial_guidelines, 3000),
    sanitizeLongText(body.selection_criteria, 2000),
    sanitizeLongText(body.rejection_criteria, 2000),
    sanitizeLongText(body.required_context, 2000),
    boolToInt(body.avoid_duplicate_people_stories, 1),
    boolToInt(body.allow_replies, 0),
    boolToInt(body.allow_retweets, 1),
    boolToInt(body.allow_quotes, 1),
    sanitizeTextOnlyPolicy(body.text_only_policy),
    nullableScore(body.min_score_for_text_only),
    nullableScore(body.min_score_for_media),
  ).run();
  return ok({ created: body.id });
}

async function updateCategory(req: Request, env: Env, id: string): Promise<Response> {
  const body: any = await req.json().catch(() => null);
  if (!body) return err('invalid json', 400);

  const categoryValidationError = validateCategoryEditorialInput(body);
  if (categoryValidationError) return err(categoryValidationError, 400);

  const fields: string[] = [];
  const vals: any[] = [];

  if (body.score_threshold !== undefined) {
    fields.push('score_threshold=?'); vals.push(clamp(Number(body.score_threshold) || 75, 0, 100));
  }
  if (body.freshness_hours !== undefined) {
    fields.push('freshness_hours=?'); vals.push(Math.max(1, Number(body.freshness_hours) || 48));
  }
  if (body.media_mode !== undefined && ['optional','preferred','disabled'].includes(body.media_mode)) {
    fields.push('media_mode=?'); vals.push(body.media_mode);
  }
  if (body.language_targets !== undefined) {
    const langs = Array.isArray(body.language_targets)
      ? body.language_targets.filter((l: any) => typeof l === 'string' && /^[a-z]{2}$/.test(l))
      : [];
    fields.push('language_targets=?'); vals.push(JSON.stringify(langs.length ? langs : ['fa']));
  }
  if (body.enabled !== undefined) {
    fields.push('enabled=?'); vals.push(body.enabled ? 1 : 0);
  }
  if (body.prompt_profile !== undefined && /^[a-z_]{1,50}$/.test(body.prompt_profile)) {
    fields.push('prompt_profile=?'); vals.push(body.prompt_profile);
  }
  if (body.custom_prompt !== undefined) {
    fields.push('custom_prompt=?'); vals.push(sanitizeLongText(body.custom_prompt, 4000));
  }
  if (body.editorial_guidelines !== undefined) {
    fields.push('editorial_guidelines=?'); vals.push(sanitizeLongText(body.editorial_guidelines, 3000));
  }
  if (body.selection_criteria !== undefined) {
    fields.push('selection_criteria=?'); vals.push(sanitizeLongText(body.selection_criteria, 2000));
  }
  if (body.rejection_criteria !== undefined) {
    fields.push('rejection_criteria=?'); vals.push(sanitizeLongText(body.rejection_criteria, 2000));
  }
  if (body.required_context !== undefined) {
    fields.push('required_context=?'); vals.push(sanitizeLongText(body.required_context, 2000));
  }
  if (body.avoid_duplicate_people_stories !== undefined) {
    fields.push('avoid_duplicate_people_stories=?'); vals.push(boolToInt(body.avoid_duplicate_people_stories, 1));
  }
  if (body.allow_replies !== undefined) {
    fields.push('allow_replies=?'); vals.push(boolToInt(body.allow_replies, 0));
  }
  if (body.allow_retweets !== undefined) {
    fields.push('allow_retweets=?'); vals.push(boolToInt(body.allow_retweets, 1));
  }
  if (body.allow_quotes !== undefined) {
    fields.push('allow_quotes=?'); vals.push(boolToInt(body.allow_quotes, 1));
  }
  if (body.text_only_policy !== undefined) {
    fields.push('text_only_policy=?'); vals.push(sanitizeTextOnlyPolicy(body.text_only_policy));
  }
  if (body.min_score_for_text_only !== undefined) {
    fields.push('min_score_for_text_only=?'); vals.push(nullableScore(body.min_score_for_text_only));
  }
  if (body.min_score_for_media !== undefined) {
    fields.push('min_score_for_media=?'); vals.push(nullableScore(body.min_score_for_media));
  }

  if (fields.length === 0) return err('no valid fields to update', 400);

  vals.push(id);
  await env.DB.prepare(`UPDATE categories SET ${fields.join(',')} WHERE id=?`).bind(...vals).run();
  return ok({ updated: id });
}

async function createChannel(req: Request, env: Env): Promise<Response> {
  const body: any = await req.json().catch(() => null);
  if (!body?.id || !body?.category_id || !body?.telegram_chat_id || !body?.language) {
    return err('missing required fields', 400);
  }

  if (!isValidId(body.id)) return err('invalid channel id', 400);
  if (!isValidId(body.category_id)) return err('invalid category_id', 400);
  if (!/^[a-z]{2}$/.test(body.language)) return err('invalid language code', 400);

  // validate chat_id: باید با @ شروع شود یا عدد منفی باشد
  const chatId = String(body.telegram_chat_id).trim();
  if (!chatId.startsWith('@') && !chatId.startsWith('-') && !/^\d+$/.test(chatId)) {
    return err('invalid telegram_chat_id format', 400);
  }

  // validate windows JSON — فقط ذخیره می‌کنیم، runtime چک می‌کند
  const allowedWindows = validateWindowsJson(body.allowed_windows, '["08:00-23:59"]');
  const blockedWindows = validateWindowsJson(body.blocked_windows, '["00:00-08:00"]');

  const formatValidationError = validateChannelFormattingInput(body);
  if (formatValidationError) return err(formatValidationError, 400);
  const editorialValidationError = validateChannelEditorialInput(body);
  if (editorialValidationError) return err(editorialValidationError, 400);

  const sourceLabelOverride = sanitizeLongText(body.source_label_override, 32);
  const signatureText = sanitizeLongText(body.signature_text, 300);
  const channelFooterText = sanitizeLongText(body.channel_id_footer_text, 80);
  const semanticWindowHours = clamp(Number(body.semantic_dedupe_window_hours) || 24, 1, 168);
  const maxPostsPerSourcePerDay = nullableBoundedInt(body.max_posts_per_source_per_day, 1, 50);
  const editorialMode = sanitizeEditorialMode(body.editorial_mode);
  const audienceLevel = sanitizeAudienceLevel(body.audience_level);
  const captionStyle = sanitizeCaptionStyle(body.caption_style);
  const creativityLevel = clampFloat(Number(body.creativity_level ?? 0.2), 0, 1);
  const captionMaxChars = clamp(Number(body.caption_max_chars) || 1200, 280, 3500);
  const captionShortMaxChars = clamp(Number(body.caption_short_max_chars) || 280, 80, 900);

  await env.DB.prepare(`
    INSERT OR IGNORE INTO channels
    (id, category_id, telegram_chat_id, language, timezone,
     allowed_windows, blocked_windows, max_per_day, max_per_hour, min_gap_minutes,
     custom_instructions, tone_profile, channel_label,
     source_enabled, source_label_override,
     signature_enabled, signature_text,
     channel_id_footer_enabled, channel_id_footer_text,
     disable_link_preview,
     semantic_dedupe_enabled, semantic_dedupe_window_hours, max_posts_per_source_per_day,
     editorial_mode, audience_level, caption_style, creativity_level,
     caption_max_chars, caption_short_max_chars, language_prompt, terminology_notes, forbidden_phrases,
     publish_enabled, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)
  `).bind(
    body.id, body.category_id, chatId, body.language,
    /^[\w/]{1,50}$/.test(body.timezone ?? '') ? body.timezone : 'Asia/Tehran',
    allowedWindows,
    blockedWindows,
    clamp(Number(body.max_per_day) || 10, 1, 100),
    clamp(Number(body.max_per_hour) || 2, 1, 20),
    clamp(Number(body.min_gap_minutes) || 30, 1, 1440),
    sanitizeLongText(body.custom_instructions, 2000),
    sanitizeToneProfile(body.tone_profile),
    sanitizeLongText(body.channel_label, 120),
    boolToInt(body.source_enabled, 1),
    sourceLabelOverride,
    boolToInt(body.signature_enabled, 0),
    signatureText,
    boolToInt(body.channel_id_footer_enabled, 0),
    channelFooterText,
    boolToInt(body.disable_link_preview, 1),
    boolToInt(body.semantic_dedupe_enabled, 1),
    semanticWindowHours,
    maxPostsPerSourcePerDay,
    editorialMode,
    audienceLevel,
    captionStyle,
    creativityLevel,
    captionMaxChars,
    captionShortMaxChars,
    sanitizeLongText(body.language_prompt, 2000),
    sanitizeLongText(body.terminology_notes, 2000),
    sanitizeForbiddenPhrases(body.forbidden_phrases),
  ).run();
  return ok({ created: body.id });
}

async function updateChannel(req: Request, env: Env, id: string): Promise<Response> {
  const body: any = await req.json().catch(() => null);
  if (!body) return err('invalid json', 400);

  const formatValidationError = validateChannelFormattingInput(body);
  if (formatValidationError) return err(formatValidationError, 400);
  const editorialValidationError = validateChannelEditorialInput(body);
  if (editorialValidationError) return err(editorialValidationError, 400);

  const fields: string[] = [];
  const vals: any[] = [];

  if (body.telegram_chat_id !== undefined) {
    const chatId = String(body.telegram_chat_id).trim();
    if (!chatId.startsWith('@') && !chatId.startsWith('-') && !/^\d+$/.test(chatId)) {
      return err('invalid telegram_chat_id', 400);
    }
    fields.push('telegram_chat_id=?'); vals.push(chatId);
  }
  if (body.timezone !== undefined && /^[\w/]{1,50}$/.test(body.timezone)) {
    fields.push('timezone=?'); vals.push(body.timezone);
  }
  if (body.max_per_day !== undefined) {
    fields.push('max_per_day=?'); vals.push(clamp(Number(body.max_per_day) || 10, 1, 100));
  }
  if (body.max_per_hour !== undefined) {
    fields.push('max_per_hour=?'); vals.push(clamp(Number(body.max_per_hour) || 2, 1, 20));
  }
  if (body.min_gap_minutes !== undefined) {
    fields.push('min_gap_minutes=?'); vals.push(clamp(Number(body.min_gap_minutes) || 30, 1, 1440));
  }
  if (body.allowed_windows !== undefined) {
    fields.push('allowed_windows=?'); vals.push(validateWindowsJson(body.allowed_windows, '["08:00-23:59"]'));
  }
  if (body.blocked_windows !== undefined) {
    fields.push('blocked_windows=?'); vals.push(validateWindowsJson(body.blocked_windows, '["00:00-08:00"]'));
  }
  if (body.enabled !== undefined) {
    fields.push('enabled=?'); vals.push(body.enabled ? 1 : 0);
  }
  if (body.custom_instructions !== undefined) {
    fields.push('custom_instructions=?'); vals.push(sanitizeLongText(body.custom_instructions, 2000));
  }
  if (body.tone_profile !== undefined) {
    fields.push('tone_profile=?'); vals.push(sanitizeToneProfile(body.tone_profile));
  }
  if (body.channel_label !== undefined) {
    fields.push('channel_label=?'); vals.push(sanitizeLongText(body.channel_label, 120));
  }
  if (body.source_enabled !== undefined) {
    fields.push('source_enabled=?'); vals.push(boolToInt(body.source_enabled, 1));
  }
  if (body.source_label_override !== undefined) {
    fields.push('source_label_override=?'); vals.push(sanitizeLongText(body.source_label_override, 32));
  }
  if (body.signature_enabled !== undefined) {
    fields.push('signature_enabled=?'); vals.push(boolToInt(body.signature_enabled, 0));
  }
  if (body.signature_text !== undefined) {
    fields.push('signature_text=?'); vals.push(sanitizeLongText(body.signature_text, 300));
  }
  if (body.channel_id_footer_enabled !== undefined) {
    fields.push('channel_id_footer_enabled=?'); vals.push(boolToInt(body.channel_id_footer_enabled, 0));
  }
  if (body.channel_id_footer_text !== undefined) {
    fields.push('channel_id_footer_text=?'); vals.push(sanitizeLongText(body.channel_id_footer_text, 80));
  }
  if (body.disable_link_preview !== undefined) {
    fields.push('disable_link_preview=?'); vals.push(boolToInt(body.disable_link_preview, 1));
  }
  if (body.semantic_dedupe_enabled !== undefined) {
    fields.push('semantic_dedupe_enabled=?'); vals.push(boolToInt(body.semantic_dedupe_enabled, 1));
  }
  if (body.semantic_dedupe_window_hours !== undefined) {
    fields.push('semantic_dedupe_window_hours=?'); vals.push(clamp(Number(body.semantic_dedupe_window_hours) || 24, 1, 168));
  }
  if (body.max_posts_per_source_per_day !== undefined) {
    fields.push('max_posts_per_source_per_day=?'); vals.push(nullableBoundedInt(body.max_posts_per_source_per_day, 1, 50));
  }
  if (body.editorial_mode !== undefined) {
    fields.push('editorial_mode=?'); vals.push(sanitizeEditorialMode(body.editorial_mode));
  }
  if (body.audience_level !== undefined) {
    fields.push('audience_level=?'); vals.push(sanitizeAudienceLevel(body.audience_level));
  }
  if (body.caption_style !== undefined) {
    fields.push('caption_style=?'); vals.push(sanitizeCaptionStyle(body.caption_style));
  }
  if (body.creativity_level !== undefined) {
    fields.push('creativity_level=?'); vals.push(clampFloat(Number(body.creativity_level), 0, 1));
  }
  if (body.caption_max_chars !== undefined) {
    fields.push('caption_max_chars=?'); vals.push(clamp(Number(body.caption_max_chars) || 1200, 280, 3500));
  }
  if (body.caption_short_max_chars !== undefined) {
    fields.push('caption_short_max_chars=?'); vals.push(clamp(Number(body.caption_short_max_chars) || 280, 80, 900));
  }
  if (body.language_prompt !== undefined) {
    fields.push('language_prompt=?'); vals.push(sanitizeLongText(body.language_prompt, 2000));
  }
  if (body.terminology_notes !== undefined) {
    fields.push('terminology_notes=?'); vals.push(sanitizeLongText(body.terminology_notes, 2000));
  }
  if (body.forbidden_phrases !== undefined) {
    fields.push('forbidden_phrases=?'); vals.push(sanitizeForbiddenPhrases(body.forbidden_phrases));
  }

  if (fields.length === 0) return err('no valid fields', 400);
  vals.push(id);
  await env.DB.prepare(`UPDATE channels SET ${fields.join(',')} WHERE id=?`).bind(...vals).run();
  return ok({ updated: id });
}

async function createSourceAccount(req: Request, env: Env): Promise<Response> {
  const body: any = await req.json().catch(() => null);
  if (!body?.category_id || !body?.platform || !body?.account_handle) {
    return err('missing required fields', 400);
  }

  if (!isValidId(body.category_id)) return err('invalid category_id', 400);
  const validPlatforms = ['x', 'instagram', 'linkedin', 'rss'];
  if (!validPlatforms.includes(body.platform)) return err('invalid platform', 400);
  const handle = String(body.account_handle).replace('@', '').trim();
  if (!/^[\w.-]{1,100}$/.test(handle)) return err('invalid account_handle', 400);

  const validTrust = ['high', 'medium', 'low'];
  const trust = validTrust.includes(body.trust_level) ? body.trust_level : 'medium';

  const id = `sa_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await env.DB.prepare(`
    INSERT INTO source_accounts (id, category_id, platform, account_handle, display_name, trust_level, enabled)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).bind(id, body.category_id, body.platform, handle,
    body.display_name ? String(body.display_name).slice(0, 100) : null, trust).run();
  return ok({ created: id });
}

async function createApifySource(req: Request, env: Env): Promise<Response> {
  const body: any = await req.json().catch(() => null);
  if (!body?.category_id || !body?.platform || !body?.apify_dataset_id) {
    return err('missing required fields', 400);
  }

  if (!isValidId(body.category_id)) return err('invalid category_id', 400);
  if (!isValidPlatform(body.platform)) return err('invalid platform', 400);

  const datasetId = sanitizeApifyDatasetId(body.apify_dataset_id);
  if (!datasetId) return err('invalid apify_dataset_id format', 400);

  const actorId = body.apify_actor_id === undefined ? null : sanitizeApifyExternalId(body.apify_actor_id);
  if (body.apify_actor_id !== undefined && body.apify_actor_id !== null && !actorId) return err('invalid apify_actor_id', 400);

  const taskId = body.apify_task_id === undefined ? null : sanitizeApifyExternalId(body.apify_task_id);
  if (body.apify_task_id !== undefined && body.apify_task_id !== null && !taskId) return err('invalid apify_task_id', 400);

  const lastDatasetId = body.last_dataset_id === undefined || body.last_dataset_id === null
    ? null
    : sanitizeApifyDatasetId(body.last_dataset_id);
  if (body.last_dataset_id !== undefined && body.last_dataset_id !== null && !lastDatasetId) return err('invalid last_dataset_id', 400);

  const sourceConfig = sanitizeJsonObject(body.source_config, 4000);
  if (sourceConfig === null) return err('invalid source_config', 400);

  const id = `src_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await env.DB.prepare(`
    INSERT INTO apify_sources
    (id, category_id, platform, apify_dataset_id, label, enabled, apify_actor_id, apify_task_id, last_dataset_id, source_config)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
  `).bind(
    id,
    body.category_id,
    body.platform,
    datasetId,
    sanitizeLongText(body.label, 100),
    actorId,
    taskId,
    lastDatasetId,
    sourceConfig,
  ).run();
  return ok({ created: id });
}

async function updateApifySource(req: Request, env: Env, id: string): Promise<Response> {
  const body: any = await req.json().catch(() => null);
  if (!body) return err('invalid json', 400);

  const fields: string[] = [];
  const vals: any[] = [];

  if (body.category_id !== undefined) {
    if (!isValidId(body.category_id)) return err('invalid category_id', 400);
    fields.push('category_id=?'); vals.push(body.category_id);
  }
  if (body.platform !== undefined) {
    if (!isValidPlatform(body.platform)) return err('invalid platform', 400);
    fields.push('platform=?'); vals.push(body.platform);
  }
  if (body.apify_dataset_id !== undefined) {
    const datasetId = sanitizeApifyDatasetId(body.apify_dataset_id);
    if (!datasetId) return err('invalid apify_dataset_id', 400);
    fields.push('apify_dataset_id=?'); vals.push(datasetId);
  }
  if (body.label !== undefined) {
    fields.push('label=?'); vals.push(sanitizeLongText(body.label, 100));
  }
  if (body.enabled !== undefined) {
    fields.push('enabled=?'); vals.push(toBoolInt(body.enabled, 1));
  }
  if (body.apify_actor_id !== undefined) {
    const actorId = body.apify_actor_id === null ? null : sanitizeApifyExternalId(body.apify_actor_id);
    if (body.apify_actor_id !== null && !actorId) return err('invalid apify_actor_id', 400);
    fields.push('apify_actor_id=?'); vals.push(actorId);
  }
  if (body.apify_task_id !== undefined) {
    const taskId = body.apify_task_id === null ? null : sanitizeApifyExternalId(body.apify_task_id);
    if (body.apify_task_id !== null && !taskId) return err('invalid apify_task_id', 400);
    fields.push('apify_task_id=?'); vals.push(taskId);
  }
  if (body.last_dataset_id !== undefined) {
    const lastDatasetId = body.last_dataset_id === null ? null : sanitizeApifyDatasetId(body.last_dataset_id);
    if (body.last_dataset_id !== null && !lastDatasetId) return err('invalid last_dataset_id', 400);
    fields.push('last_dataset_id=?'); vals.push(lastDatasetId);
  }
  if (body.source_config !== undefined) {
    const sourceConfig = sanitizeJsonObject(body.source_config, 4000);
    if (sourceConfig === null) return err('invalid source_config', 400);
    fields.push('source_config=?'); vals.push(sourceConfig);
  }

  if (fields.length === 0) return err('no valid fields', 400);
  vals.push(id);
  await env.DB.prepare(`UPDATE apify_sources SET ${fields.join(',')} WHERE id=?`).bind(...vals).run();
  return ok({ updated: id });
}


async function getCryptoPipelineDebug(env: Env, url: URL): Promise<Response> {
  const channelId = sanitizeDebugId(url.searchParams.get('channel') ?? 'crypto_fa_pilot', 'crypto_fa_pilot');
  const categoryId = sanitizeDebugId(url.searchParams.get('category') ?? 'crypto', 'crypto');
  const stuckMinutes = clamp(num(url.searchParams.get('stuckMinutes'), 15), 1, 1440);

  const runtime = await getRuntimeConfig(env);

  const [
    settingsRows,
    channel,
    queueCounts,
    recentPublished,
    scheduledQueue,
    failedRetryQueue,
    recentRuns,
    stuckRuns,
    sources,
    aiUsageRecent,
  ] = await Promise.all([
    env.DB.prepare('SELECT key, value, updated_at FROM settings ORDER BY key').all(),
    env.DB.prepare('SELECT * FROM channels WHERE id=?').bind(channelId).first(),
    env.DB.prepare(`
      SELECT status, COUNT(*) AS count
      FROM publish_queue
      WHERE channel_id=?
      GROUP BY status
      ORDER BY status
    `).bind(channelId).all(),
    env.DB.prepare(`
      SELECT id,item_id,status,telegram_method,scheduled_at,published_at,
             datetime(scheduled_at, 'unixepoch') AS scheduled_utc,
             datetime(published_at, 'unixepoch') AS published_utc,
             caption_short,publish_error,retry_count
      FROM publish_queue
      WHERE channel_id=? AND status='published'
      ORDER BY published_at DESC
      LIMIT 20
    `).bind(channelId).all(),
    env.DB.prepare(`
      SELECT id,item_id,status,telegram_method,scheduled_at,
             datetime(scheduled_at, 'unixepoch') AS scheduled_utc,
             caption_short,publish_error,retry_count
      FROM publish_queue
      WHERE channel_id=? AND status='scheduled'
      ORDER BY scheduled_at ASC
      LIMIT 50
    `).bind(channelId).all(),
    env.DB.prepare(`
      SELECT id,item_id,status,telegram_method,scheduled_at,
             datetime(scheduled_at, 'unixepoch') AS scheduled_utc,
             caption_short,publish_error,retry_count
      FROM publish_queue
      WHERE channel_id=? AND status IN ('failed','retry')
      ORDER BY created_at DESC
      LIMIT 50
    `).bind(channelId).all(),
    env.DB.prepare(`
      SELECT id,category_id,platform,apify_dataset_id,status,
             items_fetched,items_new,items_duplicate,items_ai_selected,
             items_ai_rejected,items_queued,error_message,duration_ms,
             created_at,completed_at
      FROM discovery_runs
      WHERE category_id=?
      ORDER BY created_at DESC
      LIMIT 20
    `).bind(categoryId).all(),
    env.DB.prepare(`
      SELECT id,category_id,platform,apify_dataset_id,status,
             items_fetched,items_new,items_duplicate,items_ai_selected,
             items_ai_rejected,items_queued,error_message,duration_ms,
             created_at,completed_at
      FROM discovery_runs
      WHERE status='processing'
        AND created_at < datetime('now', '-' || ? || ' minutes')
      ORDER BY created_at ASC
      LIMIT 20
    `).bind(stuckMinutes).all(),
    env.DB.prepare(`
      SELECT id,label,enabled,category_id,platform,apify_actor_id,apify_task_id,
             apify_dataset_id,last_dataset_id,created_at
      FROM apify_sources
      WHERE category_id=?
      ORDER BY created_at DESC
    `).bind(categoryId).all(),
    env.DB.prepare(`
      SELECT provider,purpose,model,input_tokens,output_tokens,status,error_message,created_at
      FROM ai_usage
      ORDER BY created_at DESC
      LIMIT 30
    `).all(),
  ]);

  const queueCountsMap: Record<string, number> = {};
  for (const row of (queueCounts.results ?? []) as Array<{ status?: string; count?: number }>) {
    if (row.status) queueCountsMap[row.status] = Number(row.count ?? 0);
  }

  const settings = Object.fromEntries(
    ((settingsRows.results ?? []) as Array<{ key: string; value: string }>).map(row => [row.key, row.value])
  );

  const diagnosis: string[] = [];
  if (settings.telegram_publish_enabled === 'false') {
    diagnosis.push('Telegram publishing is disabled by runtime setting.');
  }
  if (settings.apify_curation_enabled === 'false') {
    diagnosis.push('Apify curation is disabled by runtime setting; webhooks will not run AI/queue.');
  }
  if ((queueCountsMap.scheduled ?? 0) === 0) {
    diagnosis.push('No scheduled queue items exist for the selected channel.');
  }
  if ((queueCountsMap.failed ?? 0) > 0 || (queueCountsMap.retry ?? 0) > 0) {
    diagnosis.push('Failed or retry queue items exist and need inspection.');
  }
  if ((stuckRuns.results ?? []).length > 0) {
    diagnosis.push(`There are discovery runs stuck in processing for more than ${stuckMinutes} minutes.`);
  }

  return ok({
    ok: true,
    read_only: true,
    generated_at: new Date().toISOString(),
    filters: { category_id: categoryId, channel_id: channelId, stuck_minutes: stuckMinutes },
    runtime_config: {
      environment: env.ENVIRONMENT ?? 'unknown',
      curation_enabled: runtime.curationEnabled,
      curation_dry_run: runtime.curationDryRun,
      telegram_publish_enabled: runtime.telegramPublishEnabled,
      telegram_scheduler_enabled: runtime.telegramSchedulerEnabled,
      apify_scheduled_curation_enabled: env.APIFY_SCHEDULED_CURATION_ENABLED === 'true',
    },
    settings,
    channel: channel ?? null,
    queue_counts: queueCountsMap,
    recent_published: recentPublished.results ?? [],
    scheduled_queue: scheduledQueue.results ?? [],
    failed_retry_queue: failedRetryQueue.results ?? [],
    recent_runs: recentRuns.results ?? [],
    stuck_runs: stuckRuns.results ?? [],
    sources: sources.results ?? [],
    ai_usage_recent: aiUsageRecent.results ?? [],
    diagnosis,
  });
}



async function listRunEvents(env: Env, url: URL, runId: string): Promise<Response> {
  const limit = clamp(num(url.searchParams.get('limit'), 100), 1, 500);
  const severity = sanitizeOptionalEnum(url.searchParams.get('severity'), ['debug', 'info', 'warn', 'error']);
  const eventType = sanitizeOptionalDebugText(url.searchParams.get('eventType'), 120);

  const where = ['run_id=?'];
  const args: unknown[] = [runId];

  if (severity) {
    where.push('severity=?');
    args.push(severity);
  }
  if (eventType) {
    where.push('event_type=?');
    args.push(eventType);
  }

  args.push(limit);

  const rows = await env.DB.prepare(`
    SELECT id, run_id, event_type, phase, severity, message,
           category_id, platform, source_id, dataset_id, actor_run_id,
           item_id, queue_id, provider, model, input_tokens, output_tokens,
           duration_ms, metadata_json, created_at
    FROM run_events
    WHERE ${where.join(' AND ')}
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).bind(...args).all();

  return ok({
    read_only: true,
    run_id: runId,
    filters: { severity, event_type: eventType, limit },
    events: rows.results ?? [],
  });
}

async function listRunItemEvents(env: Env, url: URL, runId: string): Promise<Response> {
  const limit = clamp(num(url.searchParams.get('limit'), 200), 1, 1000);
  const status = sanitizeOptionalDebugText(url.searchParams.get('status'), 120);

  const where = ['run_id=?'];
  const args: unknown[] = [runId];

  if (status) {
    where.push('status=?');
    args.push(status);
  }

  args.push(limit);

  const rows = await env.DB.prepare(`
    SELECT id, run_id, item_id, source_url, post_id, source_account,
           phase, status, reject_reason, ai_score, ai_risk, media_count,
           queue_id, metadata_json, created_at
    FROM run_item_events
    WHERE ${where.join(' AND ')}
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).bind(...args).all();

  return ok({
    read_only: true,
    run_id: runId,
    filters: { status, limit },
    items: rows.results ?? [],
  });
}

function sanitizeOptionalDebugText(value: string | null, maxLen: number): string | null {
  if (value === null) return null;
  const raw = value.trim();
  if (!raw) return null;
  return /^[\w.:/-]{1,160}$/.test(raw) ? raw.slice(0, maxLen) : null;
}

function sanitizeOptionalEnum(value: string | null, allowed: string[]): string | null {
  if (value === null) return null;
  const raw = value.trim();
  return allowed.includes(raw) ? raw : null;
}


async function markDiscoveryRunFailedForDebug(req: Request, env: Env, runId: string): Promise<Response> {
  const url = new URL(req.url);
  const body: any = await req.json().catch(() => ({}));

  const minAgeInput = body?.minAgeMinutes ?? url.searchParams.get('minAgeMinutes');
  const minAgeMinutes = clamp(
    num(minAgeInput === undefined || minAgeInput === null ? null : String(minAgeInput), 15),
    1,
    1440,
  );

  const cutoffUtc = new Date(Date.now() - minAgeMinutes * 60_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

  const run = await env.DB
    .prepare('SELECT id,status,created_at,completed_at,error_message FROM discovery_runs WHERE id=?')
    .bind(runId)
    .first<any>();

  if (!run) {
    return Response.json({ ok: false, error: 'discovery_run_not_found', run_id: runId }, { status: 404 });
  }

  if (run.status !== 'processing') {
    return Response.json({
      ok: false,
      error: 'discovery_run_not_processing',
      run_id: runId,
      status: run.status,
    }, { status: 409 });
  }

  if (String(run.created_at ?? '') >= cutoffUtc) {
    return Response.json({
      ok: false,
      error: 'discovery_run_too_recent',
      run_id: runId,
      created_at: run.created_at,
      min_age_minutes: minAgeMinutes,
      cutoff_utc: cutoffUtc,
    }, { status: 409 });
  }

  const defaultReason = 'manually marked failed via debug repair endpoint';
  const reason = sanitizeLongText(body?.reason ?? defaultReason, 500) ?? defaultReason;

  const result = await env.DB.prepare(`
    UPDATE discovery_runs
    SET status='failed',
        error_message=?,
        completed_at=CURRENT_TIMESTAMP,
        duration_ms=CAST((julianday(CURRENT_TIMESTAMP) - julianday(created_at)) * 86400000 AS INTEGER)
    WHERE id=?
      AND status='processing'
      AND created_at < ?
  `).bind(reason, runId, cutoffUtc).run();

  const affected = result.meta.changes ?? 0;
  if (affected === 0) {
    return Response.json({
      ok: false,
      error: 'discovery_run_not_updated',
      run_id: runId,
      min_age_minutes: minAgeMinutes,
      cutoff_utc: cutoffUtc,
    }, { status: 409 });
  }

  return ok({
    updated: true,
    run_id: runId,
    previous_status: run.status,
    new_status: 'failed',
    min_age_minutes: minAgeMinutes,
    cutoff_utc: cutoffUtc,
    reason,
  });
}


async function getBacklogStats(env: Env): Promise<Response> {
  const enabled = isCandidateBacklogEnabled(env);
  const [statusCounts, topPendingAccounts, scoringUsage] = await Promise.all([
    getCandidateQueueStats(env),
    safeAll<{ source_account: string; count: number }>(env, `
      SELECT COALESCE(NULLIF(source_account,''), '__unknown__') AS source_account, COUNT(*) AS count
      FROM ai_candidate_queue
      WHERE status='pending'
      GROUP BY COALESCE(NULLIF(source_account,''), '__unknown__')
      ORDER BY count DESC
      LIMIT 20
    `),
    safeFirst<{ calls: number; tokens: number }>(env, `
      SELECT COUNT(*) as calls, COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
      FROM ai_usage
      WHERE provider='anthropic'
        AND purpose='scoring'
        AND status='success'
        AND created_at > datetime('now','-1 day')
    `, { calls: 0, tokens: 0 }),
  ]);

  const maxCalls = parseInt(env.AI_MAX_CALLS_PER_DAY || '0', 10) || 0;
  const tokenBudget = parseInt(env.AI_DAILY_TOKEN_BUDGET || '0', 10) || 0;

  return ok({
    enabled,
    status_counts: statusCounts,
    top_pending_accounts: topPendingAccounts.map(row => ({
      source_account: row.source_account,
      count: Number(row.count ?? 0),
    })),
    config: {
      scoring_batch_size: getScoringBatchSize(env),
      max_scoring_batches_per_run: getMaxScoringBatchesPerRun(env),
      drain_limit: getCandidateBacklogDrainLimit(env),
      max_attempts: getMaxCandidateAttempts(env),
      max_age_hours: getCandidateMaxAgeHours(env),
      fair_source_picker_enabled: isFairSourcePickerEnabled(env),
    },
    ai_budget: {
      calls_today: Number(scoringUsage.calls ?? 0),
      tokens_today: Number(scoringUsage.tokens ?? 0),
      max_calls: maxCalls,
      token_budget: tokenBudget,
      calls_remaining: maxCalls > 0 ? Math.max(0, maxCalls - Number(scoringUsage.calls ?? 0)) : null,
      tokens_remaining: tokenBudget > 0 ? Math.max(0, tokenBudget - Number(scoringUsage.tokens ?? 0)) : null,
    },
  });
}

async function triggerBacklogDrain(req: Request, env: Env): Promise<Response> {
  if (!isCandidateBacklogEnabled(env)) {
    return Response.json({ ok: false, error: 'backlog_disabled' }, { status: 409 });
  }

  const body: any = await req.json().catch(() => ({}));
  const rawCategory = body.category_id ?? body.categoryId;
  const categoryId = typeof rawCategory === 'string' && isValidId(rawCategory) ? rawCategory : undefined;
  const hardDrainLimit = getCandidateBacklogDrainLimit(env);
  const hardMaxBatches = getMaxScoringBatchesPerRun(env);
  const requestedLimit = body.limit === undefined || body.limit === null ? null : String(body.limit);
  const requestedMaxBatches = body.maxBatches === undefined || body.maxBatches === null ? null : String(body.maxBatches);
  const limit = clamp(num(requestedLimit, hardDrainLimit), 1, hardDrainLimit);
  const maxBatches = clamp(num(requestedMaxBatches, hardMaxBatches), 1, hardMaxBatches);
  const skipStale = body.skipStale === true || body.skip_stale === true || body.skipStale === 'true' || body.skip_stale === 'true';
  const recoverStale = body.recoverStale !== false && body.recover_stale !== false && body.recoverStale !== 'false' && body.recover_stale !== 'false';

  const drain = await drainAICandidateQueue(env, {
    categoryId,
    limit,
    maxBatches,
    skipStale,
    recoverStale,
  });

  return ok({
    category_id: categoryId ?? null,
    requested: { limit, maxBatches, skipStale, recoverStale },
    drain,
  });
}


async function getDailyReport(env: Env, url: URL): Promise<Response> {
  const hours = clamp(num(url.searchParams.get('hours'), 24), 1, 168);
  const rawCategory = url.searchParams.get('category') ?? url.searchParams.get('category_id');
  const categoryId = rawCategory && isValidId(rawCategory) ? rawCategory : undefined;
  const modifier = `-${hours} hours`;

  const categoryFilter = categoryId ? ' AND category_id=?' : '';
  const categoryParams = categoryId ? [categoryId] : [];
  const queueCategoryJoin = categoryId ? 'JOIN discovery_items di ON di.id = pq.item_id' : '';
  const queueCategoryFilter = categoryId ? ' AND di.category_id=?' : '';
  const queueCategoryParams = categoryId ? [categoryId] : [];

  const [
    runs,
    runStatuses,
    itemStatuses,
    rejectReasons,
    sourceAccounts,
    queueWindowStatuses,
    queueCurrentStatuses,
    backlogStatuses,
    backlogTopAccounts,
    aiUsage,
    recentRuns,
    stuckRuns,
    runEventSeverities,
  ] = await Promise.all([
    safeFirst<any>(env, `
      SELECT
        COUNT(*) AS runs,
        COALESCE(SUM(items_fetched), 0) AS fetched,
        COALESCE(SUM(items_duplicate), 0) AS duplicate,
        COALESCE(SUM(items_new), 0) AS fresh,
        COALESCE(SUM(items_ai_selected), 0) AS ai_selected,
        COALESCE(SUM(items_ai_rejected), 0) AS ai_rejected,
        COALESCE(SUM(items_queued), 0) AS queued,
        COALESCE(SUM(CASE WHEN status='processing' THEN 1 ELSE 0 END), 0) AS processing,
        COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END), 0) AS failed,
        MAX(created_at) AS last_run_at
      FROM discovery_runs
      WHERE created_at >= datetime('now', ?)
      ${categoryFilter}
    `, [modifier, ...categoryParams], {
      runs: 0, fetched: 0, duplicate: 0, fresh: 0, ai_selected: 0, ai_rejected: 0, queued: 0,
      processing: 0, failed: 0, last_run_at: null,
    }),

    safeAll<{ status: string; count: number }>(env, `
      SELECT status, COUNT(*) AS count
      FROM discovery_runs
      WHERE created_at >= datetime('now', ?)
      ${categoryFilter}
      GROUP BY status
      ORDER BY count DESC, status
    `, [modifier, ...categoryParams]),

    safeAll<{ status: string; count: number }>(env, `
      SELECT status, COUNT(*) AS count
      FROM discovery_items
      WHERE created_at >= datetime('now', ?)
      ${categoryFilter}
      GROUP BY status
      ORDER BY count DESC, status
    `, [modifier, ...categoryParams]),

    safeAll<{ reject_reason: string; count: number }>(env, `
      SELECT COALESCE(NULLIF(reject_reason,''), '__none__') AS reject_reason, COUNT(*) AS count
      FROM discovery_items
      WHERE created_at >= datetime('now', ?)
        AND status='ai_rejected'
        ${categoryFilter}
      GROUP BY COALESCE(NULLIF(reject_reason,''), '__none__')
      ORDER BY count DESC, reject_reason
      LIMIT 15
    `, [modifier, ...categoryParams]),

    safeAll<{ source_account: string; total: number; selected: number; rejected: number; queued: number }>(env, `
      SELECT
        COALESCE(NULLIF(source_account,''), '__unknown__') AS source_account,
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status='ai_selected' THEN 1 ELSE 0 END), 0) AS selected,
        COALESCE(SUM(CASE WHEN status='ai_rejected' THEN 1 ELSE 0 END), 0) AS rejected,
        COALESCE(SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END), 0) AS queued
      FROM discovery_items
      WHERE created_at >= datetime('now', ?)
      ${categoryFilter}
      GROUP BY COALESCE(NULLIF(source_account,''), '__unknown__')
      ORDER BY total DESC, source_account
      LIMIT 20
    `, [modifier, ...categoryParams]),

    safeAll<{ status: string; count: number }>(env, `
      SELECT pq.status AS status, COUNT(*) AS count
      FROM publish_queue pq
      ${queueCategoryJoin}
      WHERE (pq.created_at >= datetime('now', ?) OR pq.published_at >= CAST(strftime('%s','now', ?) AS INTEGER))
      ${queueCategoryFilter}
      GROUP BY pq.status
      ORDER BY count DESC, pq.status
    `, [modifier, modifier, ...queueCategoryParams]),

    safeAll<{ status: string; count: number }>(env, `
      SELECT pq.status AS status, COUNT(*) AS count
      FROM publish_queue pq
      ${queueCategoryJoin}
      WHERE 1=1
      ${queueCategoryFilter}
      GROUP BY pq.status
      ORDER BY count DESC, pq.status
    `, queueCategoryParams),

    safeAll<{ status: string; count: number }>(env, `
      SELECT status, COUNT(*) AS count
      FROM ai_candidate_queue
      WHERE 1=1
      ${categoryFilter}
      GROUP BY status
      ORDER BY count DESC, status
    `, categoryParams),

    safeAll<{ source_account: string; count: number }>(env, `
      SELECT COALESCE(NULLIF(source_account,''), '__unknown__') AS source_account, COUNT(*) AS count
      FROM ai_candidate_queue
      WHERE status='pending'
      ${categoryFilter}
      GROUP BY COALESCE(NULLIF(source_account,''), '__unknown__')
      ORDER BY count DESC, source_account
      LIMIT 20
    `, categoryParams),

    safeAll<{ provider: string; purpose: string; status: string; calls: number; tokens: number }>(env, `
      SELECT
        provider,
        purpose,
        status,
        COUNT(*) AS calls,
        COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
      FROM ai_usage
      WHERE created_at >= datetime('now', ?)
      GROUP BY provider, purpose, status
      ORDER BY purpose, provider, status
    `, [modifier]),

    safeAll<any>(env, `
      SELECT id, category_id, platform, apify_dataset_id, status, items_fetched, items_new,
             items_duplicate, items_ai_selected, items_ai_rejected, items_queued, error_message,
             created_at, completed_at
      FROM discovery_runs
      WHERE created_at >= datetime('now', ?)
      ${categoryFilter}
      ORDER BY created_at DESC
      LIMIT 10
    `, [modifier, ...categoryParams]),

    safeAll<any>(env, `
      SELECT id, category_id, platform, apify_dataset_id, status, error_message, created_at
      FROM discovery_runs
      WHERE status='processing'
        AND created_at < datetime('now','-30 minutes')
        ${categoryFilter}
      ORDER BY created_at ASC
      LIMIT 10
    `, categoryParams),

    safeAll<{ severity: string; count: number }>(env, `
      SELECT severity, COUNT(*) AS count
      FROM run_events
      WHERE created_at >= datetime('now', ?)
      GROUP BY severity
      ORDER BY count DESC, severity
    `, [modifier]),
  ]);

  const runSummary = {
    runs: toCount(runs.runs),
    fetched: toCount(runs.fetched),
    duplicate: toCount(runs.duplicate),
    fresh: toCount(runs.fresh),
    ai_selected: toCount(runs.ai_selected),
    ai_rejected: toCount(runs.ai_rejected),
    queued: toCount(runs.queued),
    processing: toCount(runs.processing),
    failed: toCount(runs.failed),
    last_run_at: runs.last_run_at ?? null,
  };

  const duplicateRate = runSummary.fetched > 0 ? pct(runSummary.duplicate, runSummary.fetched) : null;
  const freshRate = runSummary.fetched > 0 ? pct(runSummary.fresh, runSummary.fetched) : null;
  const aiSelectRate = (runSummary.ai_selected + runSummary.ai_rejected) > 0
    ? pct(runSummary.ai_selected, runSummary.ai_selected + runSummary.ai_rejected)
    : null;
  const queuedRate = runSummary.fresh > 0 ? pct(runSummary.queued, runSummary.fresh) : null;

  const aiBudget = summarizeAIUsage(aiUsage, env);
  const notes = buildDailyReportNotes({
    runs: runSummary,
    duplicateRate,
    aiSelectRate,
    queuedRate,
    queueCurrent: queueCurrentStatuses,
    backlogStatuses,
    aiBudget,
    stuckRunsCount: stuckRuns.length,
  });

  return ok({
    read_only: true,
    window: {
      hours,
      category_id: categoryId ?? null,
    },
    funnel: {
      ...runSummary,
      duplicate_rate_pct: duplicateRate,
      fresh_rate_pct: freshRate,
      ai_select_rate_pct: aiSelectRate,
      queued_rate_of_fresh_pct: queuedRate,
    },
    statuses: {
      discovery_runs: countRowsToObject(runStatuses),
      discovery_items: countRowsToObject(itemStatuses),
      publish_queue_window: countRowsToObject(queueWindowStatuses),
      publish_queue_current: countRowsToObject(queueCurrentStatuses),
      ai_candidate_backlog: countRowsToObject(backlogStatuses),
      run_events_by_severity: countRowsToObject(runEventSeverities, 'severity'),
    },
    rejection_reasons: rejectReasons.map(row => ({
      reason: row.reject_reason,
      count: toCount(row.count),
    })),
    source_accounts: sourceAccounts.map(row => {
      const total = toCount(row.total);
      const selected = toCount(row.selected);
      const rejected = toCount(row.rejected);
      return {
        source_account: row.source_account,
        total,
        selected,
        rejected,
        queued: toCount(row.queued),
        select_rate_pct: total > 0 ? pct(selected, total) : null,
      };
    }),
    backlog: {
      enabled: isCandidateBacklogEnabled(env),
      fair_source_picker_enabled: isFairSourcePickerEnabled(env),
      status_counts: countRowsToObject(backlogStatuses),
      pending_total: countRowsToObject(backlogStatuses).pending ?? 0,
      scoring_total: countRowsToObject(backlogStatuses).scoring ?? 0,
      failed_total: countRowsToObject(backlogStatuses).failed ?? 0,
      top_pending_accounts: backlogTopAccounts.map(row => ({
        source_account: row.source_account,
        count: toCount(row.count),
      })),
    },
    ai_budget: aiBudget,
    recent_runs: recentRuns,
    stuck_runs: stuckRuns,
    notes,
  });
}


interface MarketTrendingSourceRow {
  id: string;
  category_id: string;
  platform: string;
  apify_dataset_id: string;
  label: string | null;
  enabled: number;
  apify_actor_id?: string | null;
  apify_task_id?: string | null;
  last_dataset_id?: string | null;
  source_config?: string | null;
  created_at?: string | null;
}

interface MarketTrendingRunRow {
  id: string;
  category_id: string;
  platform: string;
  apify_dataset_id: string;
  status: string;
  items_fetched: number;
  items_new: number;
  items_duplicate: number;
  items_ai_selected: number;
  items_ai_rejected: number;
  items_queued: number;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

async function getMarketTrendingReport(env: Env, url: URL): Promise<Response> {
  const hours = clamp(num(url.searchParams.get('hours'), 48), 1, 168);
  const modifier = `-${hours} hours`;
  const sourceId = 'src_market_trending_x';

  const source = await safeFirst<MarketTrendingSourceRow | null>(env, `
    SELECT id, category_id, platform, apify_dataset_id, label, enabled,
           apify_actor_id, apify_task_id, last_dataset_id, source_config, created_at
    FROM apify_sources
    WHERE id=?
    LIMIT 1
  `, [sourceId], null);

  if (!source) {
    return Response.json({
      ok: false,
      error: 'source_not_found',
      source_id: sourceId,
      hint: 'Apply migration 0016_market_trending_source_seed.sql before using this report.',
    }, { status: 404 });
  }

  const isPlaceholder = isMarketTrendingPlaceholderDataset(source.apify_dataset_id);
  const datasetIds = Array.from(new Set([
    source.apify_dataset_id,
    source.last_dataset_id ?? '',
  ].filter(id => id && !isMarketTrendingPlaceholderDataset(id))));

  const runRowsFromEvents = await safeAll<MarketTrendingRunRow>(env, `
    SELECT dr.id, dr.category_id, dr.platform, dr.apify_dataset_id, dr.status,
           dr.items_fetched, dr.items_new, dr.items_duplicate, dr.items_ai_selected,
           dr.items_ai_rejected, dr.items_queued, dr.error_message, dr.created_at, dr.completed_at
    FROM discovery_runs dr
    WHERE dr.created_at >= datetime('now', ?)
      AND dr.id IN (
        SELECT DISTINCT run_id
        FROM run_events
        WHERE source_id=?
          AND created_at >= datetime('now', ?)
      )
    ORDER BY dr.created_at DESC
    LIMIT 200
  `, [modifier, sourceId, modifier]);

  let runRows = runRowsFromEvents;
  if (runRows.length === 0 && datasetIds.length > 0) {
    const placeholders = datasetIds.map(() => '?').join(',');
    runRows = await safeAll<MarketTrendingRunRow>(env, `
      SELECT id, category_id, platform, apify_dataset_id, status,
             items_fetched, items_new, items_duplicate, items_ai_selected,
             items_ai_rejected, items_queued, error_message, created_at, completed_at
      FROM discovery_runs
      WHERE created_at >= datetime('now', ?)
        AND apify_dataset_id IN (${placeholders})
      ORDER BY created_at DESC
      LIMIT 200
    `, [modifier, ...datasetIds]);
  }

  const runIds = runRows.map(row => row.id).filter(isValidId).slice(0, 200);
  const runPlaceholders = runIds.map(() => '?').join(',');

  const [rejectReasons, sourceAccounts, backlogStatuses, backlogPendingAccounts] = runIds.length > 0
    ? await Promise.all([
        safeAll<{ reject_reason: string; count: number }>(env, `
          SELECT COALESCE(NULLIF(reject_reason,''), '__none__') AS reject_reason, COUNT(*) AS count
          FROM discovery_items
          WHERE run_id IN (${runPlaceholders})
            AND status='ai_rejected'
          GROUP BY COALESCE(NULLIF(reject_reason,''), '__none__')
          ORDER BY count DESC, reject_reason
          LIMIT 15
        `, runIds),
        safeAll<{ source_account: string; total: number; selected: number; rejected: number; queued: number }>(env, `
          SELECT
            COALESCE(NULLIF(source_account,''), '__unknown__') AS source_account,
            COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status='ai_selected' THEN 1 ELSE 0 END), 0) AS selected,
            COALESCE(SUM(CASE WHEN status='ai_rejected' THEN 1 ELSE 0 END), 0) AS rejected,
            COALESCE(SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END), 0) AS queued
          FROM discovery_items
          WHERE run_id IN (${runPlaceholders})
          GROUP BY COALESCE(NULLIF(source_account,''), '__unknown__')
          ORDER BY total DESC, source_account
          LIMIT 20
        `, runIds),
        safeAll<{ status: string; count: number }>(env, `
          SELECT status, COUNT(*) AS count
          FROM ai_candidate_queue
          WHERE source_id=?
          GROUP BY status
          ORDER BY count DESC, status
        `, [sourceId]),
        safeAll<{ source_account: string; count: number }>(env, `
          SELECT COALESCE(NULLIF(source_account,''), '__unknown__') AS source_account, COUNT(*) AS count
          FROM ai_candidate_queue
          WHERE source_id=? AND status='pending'
          GROUP BY COALESCE(NULLIF(source_account,''), '__unknown__')
          ORDER BY count DESC, source_account
          LIMIT 20
        `, [sourceId]),
      ])
    : await Promise.all([
        Promise.resolve([] as Array<{ reject_reason: string; count: number }>),
        Promise.resolve([] as Array<{ source_account: string; total: number; selected: number; rejected: number; queued: number }>),
        safeAll<{ status: string; count: number }>(env, `
          SELECT status, COUNT(*) AS count
          FROM ai_candidate_queue
          WHERE source_id=?
          GROUP BY status
          ORDER BY count DESC, status
        `, [sourceId]),
        safeAll<{ source_account: string; count: number }>(env, `
          SELECT COALESCE(NULLIF(source_account,''), '__unknown__') AS source_account, COUNT(*) AS count
          FROM ai_candidate_queue
          WHERE source_id=? AND status='pending'
          GROUP BY COALESCE(NULLIF(source_account,''), '__unknown__')
          ORDER BY count DESC, source_account
          LIMIT 20
        `, [sourceId]),
      ]);

  const pipeline = summarizeMarketTrendingRuns(runRows);
  const duplicateRate = pipeline.items_fetched > 0 ? pct(pipeline.items_duplicate, pipeline.items_fetched) : 0;
  const aiScored = pipeline.items_ai_selected + pipeline.items_ai_rejected;
  const aiSelectRate = aiScored > 0 ? pct(pipeline.items_ai_selected, aiScored) : 0;
  const queuedRate = pipeline.items_new > 0 ? pct(pipeline.items_queued, pipeline.items_new) : 0;
  const recommendation = getMarketTrendingRecommendation({
    enabled: source.enabled === 1,
    isPlaceholder,
    runs: pipeline.runs,
    duplicateRate,
    aiSelectRate,
    queuedRate,
  });
  const warnings = buildMarketTrendingWarnings({
    enabled: source.enabled === 1,
    isPlaceholder,
    runs: pipeline.runs,
    duplicateRate,
    aiSelectRate,
    queuedRate,
    backlog: countRowsToObject(backlogStatuses),
  });

  return ok({
    read_only: true,
    generated_at: new Date().toISOString(),
    window: { hours },
    source: {
      id: source.id,
      label: source.label,
      category_id: source.category_id,
      platform: source.platform,
      enabled: source.enabled === 1,
      apify_dataset_id: source.apify_dataset_id,
      apify_task_id: source.apify_task_id ?? null,
      last_dataset_id: source.last_dataset_id ?? null,
      is_placeholder: isPlaceholder,
      webhook_source_id: sourceId,
      webhook_url_pattern: `/webhook/apify?source_id=${sourceId}&secret=***`,
    },
    pipeline,
    quality: {
      duplicate_rate_pct: duplicateRate,
      ai_select_rate_pct: aiSelectRate,
      queued_rate_of_fresh_pct: queuedRate,
    },
    statuses: {
      runs: statusCountsFromRuns(runRows),
      backlog: countRowsToObject(backlogStatuses),
    },
    rejection_reasons: rejectReasons.map(row => ({
      reason: row.reject_reason,
      count: toCount(row.count),
    })),
    source_accounts: sourceAccounts.map(row => {
      const total = toCount(row.total);
      const selected = toCount(row.selected);
      return {
        source_account: row.source_account,
        total,
        selected,
        rejected: toCount(row.rejected),
        queued: toCount(row.queued),
        select_rate_pct: total > 0 ? pct(selected, total) : 0,
      };
    }),
    backlog: {
      status_counts: countRowsToObject(backlogStatuses),
      top_pending_accounts: backlogPendingAccounts.map(row => ({
        source_account: row.source_account,
        count: toCount(row.count),
      })),
    },
    recommendation,
    warnings,
    notes: [
      'This report is read-only and does not enable the source.',
      `Use webhook source_id=${sourceId} for Apify setup.`,
    ],
  });
}

function isMarketTrendingPlaceholderDataset(value: string | null | undefined): boolean {
  const v = String(value ?? '').trim();
  return !v || v === 'PLACEHOLDER_REPLACE_BEFORE_ENABLE';
}

function summarizeMarketTrendingRuns(rows: MarketTrendingRunRow[]) {
  const out = {
    runs: rows.length,
    items_fetched: 0,
    items_new: 0,
    items_duplicate: 0,
    items_ai_selected: 0,
    items_ai_rejected: 0,
    items_queued: 0,
    failed_runs: 0,
    processing_runs: 0,
    last_run_at: null as string | null,
  };
  for (const row of rows) {
    out.items_fetched += toCount(row.items_fetched);
    out.items_new += toCount(row.items_new);
    out.items_duplicate += toCount(row.items_duplicate);
    out.items_ai_selected += toCount(row.items_ai_selected);
    out.items_ai_rejected += toCount(row.items_ai_rejected);
    out.items_queued += toCount(row.items_queued);
    if (row.status === 'failed') out.failed_runs++;
    if (row.status === 'processing') out.processing_runs++;
    if (!out.last_run_at || String(row.created_at) > out.last_run_at) out.last_run_at = row.created_at;
  }
  return out;
}

function statusCountsFromRuns(rows: MarketTrendingRunRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const status = String(row.status || '__unknown__');
    out[status] = (out[status] ?? 0) + 1;
  }
  return out;
}

function getMarketTrendingRecommendation(input: {
  enabled: boolean;
  isPlaceholder: boolean;
  runs: number;
  duplicateRate: number;
  aiSelectRate: number;
  queuedRate: number;
}): 'not_started' | 'monitoring' | 'keep' | 'tune_or_disable' {
  if (!input.enabled || input.isPlaceholder) return 'not_started';
  if (input.runs === 0) return 'monitoring';
  if (input.duplicateRate >= 70 || input.aiSelectRate < 10 || input.queuedRate < 5) return 'tune_or_disable';
  return 'keep';
}

function buildMarketTrendingWarnings(input: {
  enabled: boolean;
  isPlaceholder: boolean;
  runs: number;
  duplicateRate: number;
  aiSelectRate: number;
  queuedRate: number;
  backlog: Record<string, number>;
}): string[] {
  const warnings: string[] = [];
  if (!input.enabled) warnings.push('source_disabled');
  if (input.isPlaceholder) warnings.push('placeholder_dataset_id_replace_before_enable');
  if (input.enabled && input.runs === 0) warnings.push('source_enabled_but_no_runs_in_window');
  if (input.duplicateRate >= 70) warnings.push('high_duplicate_rate_tune_query_or_reduce_overlap');
  if (input.runs > 0 && input.aiSelectRate < 10) warnings.push('low_ai_select_rate_tune_query');
  if (input.runs > 0 && input.queuedRate < 5) warnings.push('low_queue_rate_check_rule_gate_translation_or_quality');
  if ((input.backlog.pending ?? 0) > 0) warnings.push('pending_backlog_candidates_exist');
  if ((input.backlog.failed ?? 0) > 0) warnings.push('failed_backlog_candidates_exist');
  return warnings;
}

async function getStats(env: Env): Promise<Response> {
  const [categories, channels, queuePending, queueRetry, queueFailed, queuePublished, lastRun, itemsToday, settingsRows, mediaPending, mediaFailed, mediaUploaded, aiUsage24h, aiScoring24h, aiTranslation24h] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) as n FROM categories WHERE enabled=1").first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) as n FROM channels WHERE enabled=1").first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) as n FROM publish_queue WHERE status='scheduled'").first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) as n FROM publish_queue WHERE status='retry'").first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) as n FROM publish_queue WHERE status='failed'").first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) as n FROM publish_queue WHERE status='published' AND published_at > strftime('%s','now','-1 day')").first<{ n: number }>(),
    env.DB.prepare("SELECT id,status,category_id,platform,items_new,items_queued,created_at FROM discovery_runs ORDER BY created_at DESC LIMIT 1").first<any>(),
    env.DB.prepare("SELECT COUNT(*) as n FROM discovery_items WHERE created_at > datetime('now','-1 day')").first<{ n: number }>(),
    env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>(),
    env.DB.prepare("SELECT COUNT(*) as n FROM discovery_media WHERE processing_status IN ('pending','validating','ready')").first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) as n FROM discovery_media WHERE processing_status IN ('failed','unsupported','too_large','expired')").first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) as n FROM discovery_media WHERE processing_status='uploaded'").first<{ n: number }>(),
    safeFirst<{ calls: number; tokens: number }>(env, "SELECT COUNT(*) as calls, COALESCE(SUM(input_tokens + output_tokens), 0) as tokens FROM ai_usage WHERE status='success' AND created_at > datetime('now','-1 day')", { calls: 0, tokens: 0 }),
    safeFirst<{ calls: number; tokens: number }>(env, "SELECT COUNT(*) as calls, COALESCE(SUM(input_tokens + output_tokens), 0) as tokens FROM ai_usage WHERE purpose='scoring' AND status='success' AND created_at > datetime('now','-1 day')", { calls: 0, tokens: 0 }),
    safeFirst<{ calls: number; tokens: number }>(env, "SELECT COUNT(*) as calls, COALESCE(SUM(input_tokens + output_tokens), 0) as tokens FROM ai_usage WHERE purpose='translation' AND status='success' AND created_at > datetime('now','-1 day')", { calls: 0, tokens: 0 }),
  ]);

  const runtime = await getRuntimeConfig(env);
  const stream = getStreamTranscodeState(env);

  return ok({
    categories:    categories?.n    ?? 0,
    channels:      channels?.n      ?? 0,
    queue_pending: queuePending?.n  ?? 0,
    queue_retry:   queueRetry?.n    ?? 0,
    queue_failed:  queueFailed?.n   ?? 0,
    published_24h: queuePublished?.n ?? 0,
    items_today:   itemsToday?.n    ?? 0,
    media_pending: mediaPending?.n ?? 0,
    media_failed:  mediaFailed?.n  ?? 0,
    media_uploaded: mediaUploaded?.n ?? 0,
    ai_calls_24h: Number(aiUsage24h?.calls ?? 0),
    ai_tokens_24h: Number(aiUsage24h?.tokens ?? 0),
    ai_scoring_calls_24h: Number(aiScoring24h?.calls ?? 0),
    ai_scoring_tokens_24h: Number(aiScoring24h?.tokens ?? 0),
    ai_translation_calls_24h: Number(aiTranslation24h?.calls ?? 0),
    ai_translation_tokens_24h: Number(aiTranslation24h?.tokens ?? 0),
    last_run:      lastRun ?? null,
    runtime_config: {
      environment: env.ENVIRONMENT ?? 'unknown',
      media_processing_mode: env.MEDIA_PROCESSING_MODE ?? 'direct_url',
      media_group_partial_publish_enabled: env.MEDIA_GROUP_PARTIAL_PUBLISH_ENABLED !== 'false',
      maintenance_mode: runtime.maintenanceMode,
      curation_enabled: runtime.curationEnabled,
      dry_run_enabled: runtime.curationDryRun,
      telegram_publish_enabled: runtime.telegramPublishEnabled,
      telegram_scheduler_enabled: runtime.telegramSchedulerEnabled,
      ai_max_scoring_calls_per_day: parseInt(env.AI_MAX_CALLS_PER_DAY || '0', 10) || 0,
      ai_daily_token_budget: parseInt(env.AI_DAILY_TOKEN_BUDGET || '0', 10) || 0,
      ai_max_output_tokens: parseInt(env.AI_MAX_OUTPUT_TOKENS || '0', 10) || 0,
      stream_transcode: {
        enabled: stream.enabled,
        explicitly_enabled: stream.explicitlyEnabled,
        configured: stream.configured,
        has_account_id: stream.hasAccountId,
        has_api_token: stream.hasApiToken,
        reason: stream.reason,
      },
    },
  });
}

// ── Helpers ───────────────────────────────────────────────────

// ── Daily report helpers ───────────────────────────────────────

function toCount(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function pct(part: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.round((part / total) * 10000) / 100;
}

function countRowsToObject(rows: Array<{ status?: string; severity?: string; count: number }>, key: 'status' | 'severity' = 'status'): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const name = String(row[key] ?? '__unknown__');
    out[name] = toCount(row.count);
  }
  return out;
}

interface DailyReportNotesInput {
  runs: { runs: number; fetched: number; duplicate: number; fresh: number; ai_selected: number; ai_rejected: number; queued: number; processing: number; failed: number };
  duplicateRate: number | null;
  aiSelectRate: number | null;
  queuedRate: number | null;
  queueCurrent: Array<{ status: string; count: number }>;
  backlogStatuses: Array<{ status: string; count: number }>;
  aiBudget: ReturnType<typeof summarizeAIUsage>;
  stuckRunsCount: number;
}

function buildDailyReportNotes(input: DailyReportNotesInput): string[] {
  const notes: string[] = [];
  const queueCurrent = countRowsToObject(input.queueCurrent);
  const backlog = countRowsToObject(input.backlogStatuses);

  if (input.runs.runs === 0) notes.push('no_discovery_runs_in_window');
  if (input.runs.fetched > 0 && input.runs.fresh === 0) notes.push('all_fetched_items_were_duplicates');
  if ((input.duplicateRate ?? 0) >= 80) notes.push('high_duplicate_rate');
  if (input.runs.fresh > 0 && input.runs.ai_selected === 0) notes.push('fresh_items_but_no_ai_selected_items');
  if (input.runs.ai_rejected > 0 && input.runs.ai_selected === 0) notes.push('ai_rejected_every_scored_item');
  if (input.runs.queued === 0 && input.runs.ai_selected > 0) notes.push('ai_selected_items_did_not_create_queue_items');
  if ((queueCurrent.scheduled ?? 0) === 0 && (queueCurrent.retry ?? 0) === 0) notes.push('publish_queue_has_no_due_backlog');
  if ((backlog.pending ?? 0) > 0) notes.push('ai_candidate_backlog_has_pending_items');
  if ((backlog.scoring ?? 0) > 0) notes.push('ai_candidate_backlog_has_scoring_items');
  if ((backlog.failed ?? 0) > 0) notes.push('ai_candidate_backlog_has_failed_items');
  if (input.stuckRunsCount > 0) notes.push('stale_processing_discovery_runs_detected');
  if (input.aiBudget.scoring.calls_remaining === 0) notes.push('ai_scoring_call_budget_exhausted');
  if (input.aiBudget.scoring.tokens_remaining === 0) notes.push('ai_scoring_token_budget_exhausted');
  return notes;
}

function summarizeAIUsage(rows: Array<{ provider: string; purpose: string; status: string; calls: number; tokens: number }>, env: Env) {
  const byPurpose: Record<string, { calls: number; tokens: number; failed: number; skipped: number }> = {
    scoring: { calls: 0, tokens: 0, failed: 0, skipped: 0 },
    translation: { calls: 0, tokens: 0, failed: 0, skipped: 0 },
  };
  const byProvider: Record<string, { calls: number; tokens: number; failed: number; skipped: number }> = {};

  for (const row of rows) {
    const purpose = String(row.purpose || 'unknown');
    const provider = String(row.provider || 'unknown');
    const calls = toCount(row.calls);
    const tokens = toCount(row.tokens);
    const status = String(row.status || 'success');

    const purposeBucket = byPurpose[purpose] ?? (byPurpose[purpose] = { calls: 0, tokens: 0, failed: 0, skipped: 0 });
    const providerBucket = byProvider[provider] ?? (byProvider[provider] = { calls: 0, tokens: 0, failed: 0, skipped: 0 });

    if (status === 'success') {
      purposeBucket.calls += calls;
      purposeBucket.tokens += tokens;
      providerBucket.calls += calls;
      providerBucket.tokens += tokens;
    } else if (status === 'failed') {
      purposeBucket.failed += calls;
      providerBucket.failed += calls;
    } else if (status === 'skipped') {
      purposeBucket.skipped += calls;
      providerBucket.skipped += calls;
    }
  }

  const maxCalls = parseInt(env.AI_MAX_CALLS_PER_DAY || '0', 10) || 0;
  const tokenBudget = parseInt(env.AI_DAILY_TOKEN_BUDGET || '0', 10) || 0;
  const scoringCalls = byPurpose.scoring?.calls ?? 0;
  const scoringTokens = byPurpose.scoring?.tokens ?? 0;

  return {
    scoring: {
      ...byPurpose.scoring,
      max_calls: maxCalls,
      token_budget: tokenBudget,
      calls_remaining: maxCalls > 0 ? Math.max(0, maxCalls - scoringCalls) : null,
      tokens_remaining: tokenBudget > 0 ? Math.max(0, tokenBudget - scoringTokens) : null,
    },
    translation: byPurpose.translation,
    by_provider: byProvider,
  };
}

async function safeFirst<T>(env: Env, sql: string, paramsOrFallback: unknown[] | T, maybeFallback?: T): Promise<T> {
  const params   = Array.isArray(paramsOrFallback) ? paramsOrFallback : [];
  const fallback = Array.isArray(paramsOrFallback) ? (maybeFallback as T) : (paramsOrFallback as T);
  try {
    const stmt = env.DB.prepare(sql);
    const result = params.length > 0
      ? await stmt.bind(...params).first<T>()
      : await stmt.first<T>();
    return result ?? fallback;
  } catch {
    return fallback;
  }
}

async function safeAll<T>(env: Env, sql: string, params: unknown[] = []): Promise<T[]> {
  try {
    const stmt = env.DB.prepare(sql);
    const result = params.length > 0
      ? await stmt.bind(...params).all<T>()
      : await stmt.all<T>();
    return result.results ?? [];
  } catch {
    return [];
  }
}

function validateWindowsJson(input: any, fallback: string): string {
  if (!input) return fallback;
  try {
    const parsed = JSON.parse(typeof input === 'string' ? input : JSON.stringify(input));
    if (!Array.isArray(parsed)) return fallback;
    const valid = parsed.filter((w: any) => typeof w === 'string' && isValidTimeWindow(w));
    return JSON.stringify(valid.length ? valid : JSON.parse(fallback));
  } catch {
    return fallback;
  }
}

function isValidTimeWindow(value: string): boolean {
  const m = value.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (!m) return false;
  const sh = Number(m[1]);
  const sm = Number(m[2]);
  const eh = Number(m[3]);
  const em = Number(m[4]);
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) return false;
  return sh * 60 + sm !== eh * 60 + em;
}


function sanitizeLongText(input: any, maxLen: number): string | null {
  if (input === null) return null;
  const value = String(input ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return value ? value.slice(0, maxLen) : null;
}

function sanitizeToneProfile(input: any): string {
  const raw = String(input ?? 'neutral').trim().toLowerCase();
  return /^[a-z_ -]{1,40}$/.test(raw) ? raw.slice(0, 40) : 'neutral';
}


function validateCategoryEditorialInput(body: any): string | null {
  const limits: Array<[string, number]> = [
    ['editorial_guidelines', 3000],
    ['selection_criteria', 2000],
    ['rejection_criteria', 2000],
    ['required_context', 2000],
  ];
  for (const [key, max] of limits) {
    if (body[key] === undefined || body[key] === null) continue;
    const value = String(body[key]).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
    if (value.length > max) return `${key}_too_long`;
  }
  if (body.text_only_policy !== undefined && !isAllowedTextOnlyPolicy(body.text_only_policy)) return 'invalid_text_only_policy';
  for (const key of ['min_score_for_text_only', 'min_score_for_media']) {
    if (body[key] === undefined || body[key] === null || body[key] === '') continue;
    const n = Number(body[key]);
    if (!Number.isFinite(n) || n < 0 || n > 100) return `${key}_out_of_range`;
  }
  return null;
}

function validateChannelEditorialInput(body: any): string | null {
  const textLimits: Array<[string, number]> = [
    ['language_prompt', 2000],
    ['terminology_notes', 2000],
  ];
  for (const [key, max] of textLimits) {
    if (body[key] === undefined || body[key] === null) continue;
    const value = String(body[key]).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
    if (value.length > max) return `${key}_too_long`;
  }
  if (body.editorial_mode !== undefined && !isAllowedEditorialMode(body.editorial_mode)) return 'invalid_editorial_mode';
  if (body.audience_level !== undefined && !isAllowedAudienceLevel(body.audience_level)) return 'invalid_audience_level';
  if (body.caption_style !== undefined && !isAllowedCaptionStyle(body.caption_style)) return 'invalid_caption_style';
  if (body.creativity_level !== undefined && body.creativity_level !== null && body.creativity_level !== '') {
    const n = Number(body.creativity_level);
    if (!Number.isFinite(n) || n < 0 || n > 1) return 'creativity_level_out_of_range';
  }
  if (body.caption_max_chars !== undefined && body.caption_max_chars !== null && body.caption_max_chars !== '') {
    const n = Number(body.caption_max_chars);
    if (!Number.isFinite(n) || n < 280 || n > 3500) return 'caption_max_chars_out_of_range';
  }
  if (body.caption_short_max_chars !== undefined && body.caption_short_max_chars !== null && body.caption_short_max_chars !== '') {
    const n = Number(body.caption_short_max_chars);
    if (!Number.isFinite(n) || n < 80 || n > 900) return 'caption_short_max_chars_out_of_range';
  }
  if (body.forbidden_phrases !== undefined) {
    const phrases = normalizeForbiddenPhrases(body.forbidden_phrases);
    if (phrases.length > 30) return 'forbidden_phrases_too_many';
    if (phrases.some(p => p.length > 80)) return 'forbidden_phrase_too_long';
  }
  return null;
}

function validateChannelFormattingInput(body: any): string | null {
  const textLimits: Array<[string, number]> = [
    ['source_label_override', 32],
    ['signature_text', 300],
    ['channel_id_footer_text', 80],
  ];

  for (const [key, max] of textLimits) {
    if (body[key] === undefined || body[key] === null) continue;
    const value = String(body[key]).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
    if (value.length > max) return `${key}_too_long`;
  }

  if (body.semantic_dedupe_window_hours !== undefined && body.semantic_dedupe_window_hours !== null && body.semantic_dedupe_window_hours !== '') {
    const n = Number(body.semantic_dedupe_window_hours);
    if (!Number.isFinite(n) || n < 1 || n > 168) return 'semantic_dedupe_window_hours_out_of_range';
  }

  if (body.max_posts_per_source_per_day !== undefined && body.max_posts_per_source_per_day !== null && body.max_posts_per_source_per_day !== '') {
    const n = Number(body.max_posts_per_source_per_day);
    if (!Number.isFinite(n) || n < 1 || n > 50) return 'max_posts_per_source_per_day_out_of_range';
  }

  return null;
}


function isAllowedEditorialMode(value: any): boolean {
  return ['news', 'educational', 'analytical', 'brief', 'explainer'].includes(String(value ?? '').trim().toLowerCase());
}

function sanitizeEditorialMode(input: any): string {
  const raw = String(input ?? 'news').trim().toLowerCase();
  return isAllowedEditorialMode(raw) ? raw : 'news';
}

function isAllowedAudienceLevel(value: any): boolean {
  return ['beginner', 'intermediate', 'professional'].includes(String(value ?? '').trim().toLowerCase());
}

function sanitizeAudienceLevel(input: any): string {
  const raw = String(input ?? 'intermediate').trim().toLowerCase();
  return isAllowedAudienceLevel(raw) ? raw : 'intermediate';
}

function isAllowedCaptionStyle(value: any): boolean {
  return ['contextual', 'straight_news', 'educational_summary', 'insight_first'].includes(String(value ?? '').trim().toLowerCase());
}

function sanitizeCaptionStyle(input: any): string {
  const raw = String(input ?? 'contextual').trim().toLowerCase();
  return isAllowedCaptionStyle(raw) ? raw : 'contextual';
}

function clampFloat(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function normalizeForbiddenPhrases(input: any): string[] {
  if (Array.isArray(input)) {
    return input.map(x => String(x ?? '').trim()).filter(Boolean);
  }
  const raw = String(input ?? '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(x => String(x ?? '').trim()).filter(Boolean);
  } catch { /* line/newline/comma format below */ }
  return raw.split(/[\n,]/).map(x => x.trim()).filter(Boolean);
}

function sanitizeForbiddenPhrases(input: any): string {
  const phrases = normalizeForbiddenPhrases(input)
    .map(phrase => phrase.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 30)
    .map(phrase => phrase.slice(0, 80));
  return JSON.stringify(phrases);
}

function isAllowedTextOnlyPolicy(value: any): boolean {
  return ['allow', 'penalize', 'reject'].includes(String(value ?? '').trim().toLowerCase());
}

function sanitizeTextOnlyPolicy(input: any): 'allow' | 'penalize' | 'reject' {
  const raw = String(input ?? 'allow').trim().toLowerCase();
  return isAllowedTextOnlyPolicy(raw) ? raw as 'allow' | 'penalize' | 'reject' : 'allow';
}

function nullableScore(input: any): number | null {
  if (input === undefined || input === null || input === '') return null;
  const n = Number(input);
  if (!Number.isFinite(n)) return null;
  return clampFloat(n, 0, 100);
}

function boolToInt(input: any, defaultValue: 0 | 1): 0 | 1 {
  if (input === undefined || input === null || input === '') return defaultValue;
  if (input === true || input === 1 || input === '1') return 1;
  if (input === false || input === 0 || input === '0') return 0;
  const normalized = String(input).trim().toLowerCase();
  if (normalized === 'true' || normalized === 'yes' || normalized === 'on') return 1;
  if (normalized === 'false' || normalized === 'no' || normalized === 'off') return 0;
  return defaultValue;
}

function nullableBoundedInt(input: any, min: number, max: number): number | null {
  if (input === undefined || input === null || input === '') return null;
  const n = Number(input);
  if (!Number.isFinite(n)) return null;
  return clamp(Math.floor(n), min, max);
}

function safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try { return JSON.parse(json) as T; } catch { return fallback; }
}

function isTruthy(value: unknown): boolean {
  if (value === false || value === 0 || value === '0') return false;
  if (typeof value === 'string' && value.toLowerCase() === 'false') return false;
  return true;
}

function isRawSourceVisible(html: string, sourceUrl: string): boolean {
  const raw = String(sourceUrl ?? '').trim();
  if (!raw) return false;
  const withoutHrefValues = String(html ?? '').replace(/href="[^"]*"/gi, '');
  const candidates = [raw, raw.replace(/\/$/, '')].filter(Boolean);
  return candidates.some(candidate => withoutHrefValues.includes(candidate));
}

function buildTelegramPreviewPayload(
  method: string,
  chatId: string,
  captions: ReturnType<typeof prepareTelegramCaptions>,
  mediaUrls: string[],
  mediaTypes: Array<'image' | 'video'>,
): object {
  if (method === 'sendPhoto') {
    return {
      method: 'sendPhoto',
      payload: {
        chat_id: chatId,
        photo: mediaUrls[0] ?? '',
        caption: captions.mediaHtml,
        parse_mode: 'HTML',
      },
      follow_up: captions.sendFullFollowUp ? buildSendMessagePreview(chatId, captions.fullHtml) : null,
    };
  }

  if (method === 'sendVideo') {
    return {
      method: 'sendVideo',
      payload: {
        chat_id: chatId,
        video: mediaUrls[0] ?? '',
        caption: captions.mediaHtml,
        parse_mode: 'HTML',
        supports_streaming: true,
      },
      follow_up: captions.sendFullFollowUp ? buildSendMessagePreview(chatId, captions.fullHtml) : null,
    };
  }

  if (method === 'sendMediaGroup') {
    const media = mediaUrls.map((url, i) => {
      const type = mediaTypes[i] === 'video' ? 'video' : 'photo';
      const entry: any = {
        type,
        media: url,
        ...(type === 'video' ? { supports_streaming: true } : {}),
      };
      if (i === 0) {
        entry.caption = captions.mediaHtml;
        entry.parse_mode = 'HTML';
      }
      return entry;
    });
    return {
      method: 'sendMediaGroup',
      payload: { chat_id: chatId, media },
      follow_up: captions.sendFullFollowUp ? buildSendMessagePreview(chatId, captions.fullHtml) : null,
    };
  }

  return {
    method: 'sendMessage',
    payload: buildSendMessagePreview(chatId, captions.fullHtml),
    follow_up: null,
  };
}

function buildSendMessagePreview(chatId: string, text: string): object {
  return {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  };
}

function ok(data: object): Response {
  return Response.json({ ok: true, ...data });
}

function err(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function num(s: string | null, def: number): number {
  if (s === null || s === '') return def;
  const n = Number(s);
  return isNaN(n) ? def : n;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function isValidPlatform(value: any): value is string {
  return ['x', 'instagram', 'linkedin', 'rss'].includes(String(value));
}

function sanitizeApifyDatasetId(value: any): string | null {
  const v = String(value ?? '').trim();
  return /^[A-Za-z0-9]{8,40}$/.test(v) ? v : null;
}

function sanitizeApifyExternalId(value: any): string | null {
  const v = String(value ?? '').trim();
  return /^[A-Za-z0-9_~./-]{1,120}$/.test(v) ? v : null;
}

function sanitizeJsonObject(input: any, maxLen: number): string | null {
  if (input === undefined || input === null || input === '') return '{}';
  try {
    const parsed = typeof input === 'string' ? JSON.parse(input) : input;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return null;
    const text = JSON.stringify(parsed);
    return text.length <= maxLen ? text : null;
  } catch {
    return null;
  }
}

function toBoolInt(value: any, defaultValue: 0 | 1 = 0): 0 | 1 {
  if (value === true || value === 'true' || value === 1 || value === '1') return 1;
  if (value === false || value === 'false' || value === 0 || value === '0') return 0;
  return defaultValue;
}
