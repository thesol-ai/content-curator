// ══════════════════════════════════════════════════════════════
// routes/admin.ts — Admin API
// نکات امنیتی:
// - همه /internal/* نیاز به x-internal-api-secret دارند (در index.ts چک می‌شود)
// - path segment‌ها sanitize می‌شوند
// - SQL همیشه parameterized است
// ══════════════════════════════════════════════════════════════

import type { Env } from '../types';
import { runCuration } from '../services/curation-orchestrator';
import { getStreamTranscodeState } from '../services/stream-config';

// ID validation — فقط alphanumeric و underscore و dash
function isValidId(id: string | undefined): id is string {
  return typeof id === 'string' && /^[\w-]{1,64}$/.test(id);
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

  let q = 'SELECT id,run_id,category_id,platform,source_account,source_url,ai_score,ai_risk,ai_priority,risk_flags,status,created_at,text,media_count,media_expected_count,media_extracted_count,media_extraction_warnings FROM discovery_items WHERE status=?';
  const params: any[] = [status];

  if (category && isValidId(category)) { q += ' AND category_id=?'; params.push(category); }
  if (platform && /^[a-z]{1,20}$/.test(platform)) { q += ' AND platform=?'; params.push(platform); }
  q += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const r = await env.DB.prepare(q).bind(...params).all();
  return ok({ items: r.results ?? [] });
}

async function listQueue(env: Env, url: URL): Promise<Response> {
  const VALID_STATUSES = ['scheduled','publishing','published','failed','retry','cancelled'];
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

  // Override در runtime env برای این request
  const overriddenEnv = Object.create(env) as Env;
  if (body.dryRun === true)  (overriddenEnv as any).APIFY_CURATION_DRY_RUN  = 'true';
  if (body.dryRun === false) (overriddenEnv as any).APIFY_CURATION_DRY_RUN  = 'false';
  if (body.force  === true)  (overriddenEnv as any).APIFY_CURATION_ENABLED   = 'true';

  const results = await runCuration(overriddenEnv);
  return ok({ triggered: true, runs: results });
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

  await env.DB.prepare(`
    INSERT OR IGNORE INTO categories
    (id, label, prompt_profile, custom_prompt, score_threshold, freshness_hours, media_mode, language_targets, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).bind(
    body.id,
    String(body.label).slice(0, 100),
    String(body.prompt_profile).slice(0, 100),
    sanitizeLongText(body.custom_prompt, 4000),
    clamp(Number(body.score_threshold) || 75, 0, 100),
    Math.max(1, Number(body.freshness_hours) || 48),
    mediaMode,
    langTargets,
  ).run();
  return ok({ created: body.id });
}

async function updateCategory(req: Request, env: Env, id: string): Promise<Response> {
  const body: any = await req.json().catch(() => null);
  if (!body) return err('invalid json', 400);

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

  await env.DB.prepare(`
    INSERT OR IGNORE INTO channels
    (id, category_id, telegram_chat_id, language, timezone,
     allowed_windows, blocked_windows, max_per_day, max_per_hour, min_gap_minutes,
     custom_instructions, tone_profile, channel_label,
     publish_enabled, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)
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
  ).run();
  return ok({ created: body.id });
}

async function updateChannel(req: Request, env: Env, id: string): Promise<Response> {
  const body: any = await req.json().catch(() => null);
  if (!body) return err('invalid json', 400);

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
  // Dataset ID فرمت Apify: حروف و اعداد
  if (!/^[A-Za-z0-9]{8,30}$/.test(body.apify_dataset_id)) {
    return err('invalid apify_dataset_id format', 400);
  }

  const id = `src_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await env.DB.prepare(`
    INSERT INTO apify_sources (id, category_id, platform, apify_dataset_id, label, enabled)
    VALUES (?, ?, ?, ?, ?, 1)
  `).bind(id, body.category_id, body.platform, body.apify_dataset_id,
    body.label ? String(body.label).slice(0, 100) : null).run();
  return ok({ created: id });
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

  const settings: Record<string, string> = {};
  for (const row of settingsRows.results ?? []) settings[row.key] = row.value;

  const curationEnabled = env.APIFY_CURATION_ENABLED === 'true' || settings.apify_curation_enabled === 'true';
  const dryRunEnabled = env.APIFY_CURATION_DRY_RUN === 'true' || settings.apify_curation_dry_run === 'true';
  const publishEnabled = env.TELEGRAM_FINAL_PUBLISH_ENABLED === 'true' || settings.telegram_publish_enabled === 'true';
  const schedulerEnabled = env.TELEGRAM_PUBLISH_SCHEDULER_ENABLED === 'true';
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
      curation_enabled: curationEnabled,
      dry_run_enabled: dryRunEnabled,
      telegram_publish_enabled: publishEnabled,
      telegram_scheduler_enabled: schedulerEnabled,
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

async function safeFirst<T>(env: Env, sql: string, fallback: T): Promise<T> {
  try {
    return (await env.DB.prepare(sql).first<T>()) ?? fallback;
  } catch {
    return fallback;
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

function ok(data: object): Response {
  return Response.json({ ok: true, ...data });
}

function err(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function num(s: string | null, def: number): number {
  const n = Number(s);
  return isNaN(n) ? def : n;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
