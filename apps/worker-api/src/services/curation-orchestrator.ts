// ══════════════════════════════════════════════════════════════
// services/curation-orchestrator.ts
// هماهنگ‌کننده اصلی پایپ‌لاین
// ══════════════════════════════════════════════════════════════

import type { Env, CategoryRow, ChannelRow, ApifySourceRow, NormalizedItem } from '../types';
import { fetchApifyDataset, normalizeItem } from './apify-client';
import { computeDedupeKeys, isDuplicate, recordDedupeKeys } from './dedupe';
import { runAIGate } from './ai-gate';
import { runRuleGate } from './rule-gate';
import { resolveMedia, extractMediaTypes } from './media-resolver';
import { publishToTelegram } from './telegram-publisher';

export interface CurationRunResult {
  runId: string;
  categoryId: string;
  platform: string;
  ok: boolean;
  itemsFetched: number;
  itemsNew: number;
  itemsDuplicate: number;
  itemsAiSelected: number;
  itemsAiRejected: number;
  itemsQueued: number;
  dryRun: boolean;
  errors: string[];
  durationMs: number;
}

// ── Entry point ───────────────────────────────────────────────

export async function runCuration(env: Env): Promise<CurationRunResult[]> {
  const enabled =
    env.APIFY_CURATION_ENABLED === 'true' ||
    (await getSetting(env, 'apify_curation_enabled')) === 'true';

  if (!enabled) return [];

  const sources = await loadApifySources(env);
  if (sources.length === 0) {
    console.log('[Curation] No Apify sources configured');
    return [];
  }

  const byCategory = new Map<string, ApifySourceRow[]>();
  for (const src of sources) {
    const list = byCategory.get(src.category_id) ?? [];
    list.push(src);
    byCategory.set(src.category_id, list);
  }

  const results: CurationRunResult[] = [];

  for (const [categoryId, categorySources] of byCategory) {
    const category = await loadCategory(env, categoryId);
    if (!category) {
      console.warn(`[Curation] Category not found or disabled: ${categoryId}`);
      continue;
    }

    for (const source of categorySources) {
      const result = await processSingleSource(env, category, source);
      results.push(result);
    }
  }

  return results;
}

// ── Process one Apify source ──────────────────────────────────

async function processSingleSource(
  env: Env,
  category: CategoryRow,
  source: ApifySourceRow
): Promise<CurationRunResult> {
  const t0 = Date.now();
  const dryRun = env.APIFY_CURATION_DRY_RUN === 'true';
  const maxItems = parseInt(env.APIFY_MAX_ITEMS_PER_SOURCE || '100', 10);
  const runId = generateId('run');

  const errors: string[] = [];
  let itemsFetched = 0, itemsNew = 0, itemsDuplicate = 0;
  let itemsAiSelected = 0, itemsAiRejected = 0, itemsQueued = 0;

  await saveDiscoveryRun(env, runId, category.id, source.platform, source.apify_dataset_id, 'processing');

  try {
    // ── 1. Fetch ──────────────────────────────────────────────
    const raw = await fetchApifyDataset(source.apify_dataset_id, env.APIFY_TOKEN, maxItems);
    itemsFetched = raw.length;

    // ── 2. Normalize ──────────────────────────────────────────
    const normalized: NormalizedItem[] = [];
    for (const r of raw) {
      const item = normalizeItem(r, source.platform as any);
      if (item && item.text.length >= 15 && item.sourceUrl) {
        normalized.push(item);
      }
    }

    // ── 3. Dedupe — یک بار compute، یک بار check ──────────────
    const fresh: NormalizedItem[] = [];
    const freshKeys: string[][] = []; // کلیدها را cache می‌کنیم تا دوباره حساب نشود

    for (const item of normalized) {
      const keys = computeDedupeKeys(item);
      if (await isDuplicate(env, keys)) {
        itemsDuplicate++;
      } else {
        fresh.push(item);
        freshKeys.push(keys); // ذخیره برای استفاده بعدی
      }
    }
    itemsNew = fresh.length;

    if (fresh.length === 0) {
      await finishRun(env, runId, category.id, source.platform, source.apify_dataset_id,
        dryRun ? 'dry_run' : 'completed',
        { itemsFetched, itemsNew, itemsDuplicate, durationMs: Date.now() - t0 });
      return mkResult(runId, category.id, source.platform, true, dryRun,
        { itemsFetched, itemsNew, itemsDuplicate, durationMs: Date.now() - t0 });
    }

    // ── 4. AI Gate (batch) ────────────────────────────────────
    const maxCandidates = parseInt(env.AI_MAX_CANDIDATES_PER_RUN || '50', 10);
    const batch = fresh.slice(0, maxCandidates);
    const batchKeys = freshKeys.slice(0, maxCandidates); // keys در همان ترتیب

    const whitelist = await loadWhitelistedAccounts(env, category.id);
    const aiResults = await runAIGate(env, batch, category, whitelist);

    // ── 5. Save items + build queue ───────────────────────────
    const channels = await loadChannels(env, category.id);

    for (let i = 0; i < batch.length; i++) {
      const item = batch[i]!;
      const ai   = aiResults[i]!;
      const keys = batchKeys[i]!; // از cache استفاده می‌کنیم — محاسبه دوم نیاز نیست

      const itemId = generateId('item');
      await saveDiscoveryItem(env, itemId, runId, category.id, item, ai);

      const rejected = !ai.publish || ai.riskLevel === 'high' || ai.score < category.score_threshold;
      if (rejected) { itemsAiRejected++; continue; }
      itemsAiSelected++;

      if (dryRun) continue;

      // Record dedupe keys (از cache — بدون محاسبه مجدد)
      await recordDedupeKeys(env, keys, itemId);

      await saveDiscoveryMedia(env, itemId, item);

      const mediaRes   = resolveMedia(item.media, category.media_mode as any);
      const mediaTypes = extractMediaTypes(item.media, category.media_mode as any);

      for (const channel of channels) {
        if (!channel.enabled) continue;

        const translation = ai.translations[channel.language];
        if (!translation) continue;

        const rule = await runRuleGate(env, ai, channel, item.mediaUrlExpiresSoon);
        if (!rule.approved || !rule.scheduledAt) continue;

        await saveQueueItem(env, {
          itemId,
          channelId:    channel.id,
          language:     channel.language,
          sourceUrl:    item.sourceUrl,
          captionShort: translation.captionShort,
          captionFull:  translation.captionFull,
          hashtags:     translation.hashtags,
          method:       mediaRes.method,
          mediaUrls:    mediaRes.mediaUrls,
          mediaTypes,
          scheduledAt:  rule.scheduledAt,
        });

        itemsQueued++;
      }
    }

    const finalStatus = dryRun ? 'dry_run' : 'completed';
    await finishRun(env, runId, category.id, source.platform, source.apify_dataset_id,
      finalStatus,
      { itemsFetched, itemsNew, itemsDuplicate, itemsAiSelected, itemsAiRejected, itemsQueued, durationMs: Date.now() - t0 });

    return mkResult(runId, category.id, source.platform, true, dryRun,
      { itemsFetched, itemsNew, itemsDuplicate, itemsAiSelected, itemsAiRejected, itemsQueued, durationMs: Date.now() - t0 });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(msg);
    console.error(`[Curation][${category.id}/${source.platform}]`, msg);
    await finishRun(env, runId, category.id, source.platform, source.apify_dataset_id,
      'failed', { itemsFetched, errorMessage: msg, durationMs: Date.now() - t0 });
    return mkResult(runId, category.id, source.platform, false, dryRun,
      { itemsFetched, errors, durationMs: Date.now() - t0 });
  }
}

// ── Publish due queue items (cron) ────────────────────────────

export async function publishDueItems(env: Env): Promise<{ published: number; failed: number }> {
  const schedulerEnabled = env.TELEGRAM_PUBLISH_SCHEDULER_ENABLED === 'true';
  if (!schedulerEnabled) return { published: 0, failed: 0 };

  const limit = parseInt(env.TELEGRAM_PUBLISH_DUE_LIMIT || '5', 10);
  const now   = Math.floor(Date.now() / 1000);

  const due = await env.DB.prepare(`
    SELECT q.*, c.telegram_chat_id, c.max_per_hour, c.min_gap_minutes, c.publish_enabled
    FROM publish_queue q
    JOIN channels c ON q.channel_id = c.id
    WHERE q.status = 'scheduled'
      AND q.scheduled_at <= ?
      AND c.publish_enabled = 1
      AND c.enabled = 1
    ORDER BY q.scheduled_at ASC
    LIMIT ?
  `).bind(now, limit).all<any>();

  let published = 0, failed = 0;

  for (const row of due.results ?? []) {
    // hourly rate limit
    const hourAgo = now - 3600;
    const thisHour = await env.DB
      .prepare(`SELECT COUNT(*) as cnt FROM publish_queue WHERE channel_id=? AND status='published' AND published_at>?`)
      .bind(row.channel_id, hourAgo).first<{ cnt: number }>();
    if ((thisHour?.cnt ?? 0) >= row.max_per_hour) continue;

    // minimum gap
    const lastPub = await env.DB
      .prepare(`SELECT published_at FROM publish_queue WHERE channel_id=? AND status='published' ORDER BY published_at DESC LIMIT 1`)
      .bind(row.channel_id).first<{ published_at: number }>();
    if (lastPub && (now - lastPub.published_at) < row.min_gap_minutes * 60) continue;

    // Optimistic lock — prevents double-publishing if cron overlaps
    const locked = await env.DB
      .prepare(`UPDATE publish_queue SET status='publishing' WHERE id=? AND status='scheduled'`)
      .bind(row.id).run();
    if (!locked.meta.changes) continue; // someone else grabbed it

    const mediaUrls:  string[]               = JSON.parse(row.media_urls  ?? '[]');
    const mediaTypes: Array<'image'|'video'> = JSON.parse(row.media_types ?? '[]');

    const result = await publishToTelegram(env, {
      chatId:       row.telegram_chat_id,
      captionShort: row.caption_short ?? '',
      captionFull:  row.caption_full  ?? '',
      sourceUrl:    row.source_url    ?? '',
      method:       row.telegram_method ?? 'sendMessage',
      mediaUrls,
      mediaTypes,
    });

    if (result.ok && result.messageId !== 'disabled_skip') {
      await env.DB
        .prepare(`UPDATE publish_queue SET status='published', telegram_message_id=?, published_at=? WHERE id=?`)
        .bind(result.messageId ?? '', now, row.id).run();
      published++;
    } else if (result.messageId === 'disabled_skip') {
      // publish disabled — revert to scheduled
      await env.DB
        .prepare(`UPDATE publish_queue SET status='scheduled' WHERE id=?`)
        .bind(row.id).run();
    } else {
      const retries = (row.retry_count ?? 0) + 1;
      const newStatus = retries >= 3 ? 'failed' : 'scheduled';
      const newAt     = retries >= 3 ? now : now + 30 * 60;
      await env.DB
        .prepare(`UPDATE publish_queue SET status=?, retry_count=?, scheduled_at=?, publish_error=? WHERE id=?`)
        .bind(newStatus, retries, newAt, (result.error ?? '').slice(0, 400), row.id).run();
      failed++;
    }
  }

  return { published, failed };
}

// ── D1 helpers ────────────────────────────────────────────────

async function loadApifySources(env: Env): Promise<ApifySourceRow[]> {
  const r = await env.DB.prepare('SELECT * FROM apify_sources WHERE enabled=1').all<ApifySourceRow>();
  return r.results ?? [];
}

async function loadCategory(env: Env, id: string): Promise<CategoryRow | null> {
  return env.DB.prepare('SELECT * FROM categories WHERE id=? AND enabled=1').bind(id).first<CategoryRow>();
}

async function loadChannels(env: Env, categoryId: string): Promise<ChannelRow[]> {
  const r = await env.DB
    .prepare('SELECT * FROM channels WHERE category_id=? AND enabled=1')
    .bind(categoryId).all<ChannelRow>();
  return r.results ?? [];
}

async function loadWhitelistedAccounts(env: Env, categoryId: string): Promise<string[]> {
  const r = await env.DB
    .prepare(`SELECT account_handle FROM source_accounts WHERE category_id=? AND enabled=1 AND trust_level IN ('high','medium')`)
    .bind(categoryId).all<{ account_handle: string }>();
  return (r.results ?? []).map(x => x.account_handle);
}

async function saveDiscoveryRun(
  env: Env, id: string, categoryId: string, platform: string,
  datasetId: string, status: string
): Promise<void> {
  await env.DB.prepare(`
    INSERT OR IGNORE INTO discovery_runs (id, category_id, platform, apify_dataset_id, status)
    VALUES (?, ?, ?, ?, ?)
  `).bind(id, categoryId, platform, datasetId, status).run();
}

async function finishRun(
  env: Env, id: string, _categoryId: string, _platform: string,
  _datasetId: string, status: string, data: Record<string, any>
): Promise<void> {
  await env.DB.prepare(`
    UPDATE discovery_runs SET
      status=?, items_fetched=?, items_new=?, items_duplicate=?,
      items_ai_selected=?, items_ai_rejected=?, items_queued=?,
      error_message=?, duration_ms=?,
      completed_at = CASE WHEN ? IN ('completed','failed','dry_run') THEN CURRENT_TIMESTAMP ELSE completed_at END
    WHERE id=?
  `).bind(
    status,
    data.itemsFetched ?? 0, data.itemsNew ?? 0, data.itemsDuplicate ?? 0,
    data.itemsAiSelected ?? 0, data.itemsAiRejected ?? 0, data.itemsQueued ?? 0,
    data.errorMessage ?? null, data.durationMs ?? null,
    status, id
  ).run();
}

async function saveDiscoveryItem(
  env: Env, id: string, runId: string, categoryId: string,
  item: NormalizedItem,
  ai: { score: number; riskLevel: string; publishPriority: string; riskFlags: string[]; topicFingerprint: string; publish: boolean }
): Promise<void> {
  const status = !ai.publish || ai.riskLevel === 'high' ? 'ai_rejected' : 'ai_selected';
  await env.DB.prepare(`
    INSERT OR IGNORE INTO discovery_items
    (id,run_id,category_id,platform,source_account,source_url,post_id,
     published_at,text,topic_fingerprint,media_count,
     engagement_likes,engagement_shares,engagement_views,
     ai_score,ai_risk,ai_priority,risk_flags,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    id, runId, categoryId, item.platform, item.sourceAccount, item.sourceUrl, item.postId,
    item.publishedAt, item.text.slice(0, 1000), ai.topicFingerprint, item.media.length,
    item.engagementLikes, item.engagementShares, item.engagementViews,
    ai.score, ai.riskLevel, ai.publishPriority,
    JSON.stringify(ai.riskFlags), status
  ).run();
}

async function saveDiscoveryMedia(env: Env, itemId: string, item: NormalizedItem): Promise<void> {
  for (let i = 0; i < item.media.length; i++) {
    const m = item.media[i]!;
    const id = generateId('med');
    await env.DB.prepare(`
      INSERT OR IGNORE INTO discovery_media (id,item_id,media_index,media_type,source_url,width,height,duration_sec,size_mb)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).bind(id, itemId, i, m.type, m.url, m.width ?? null, m.height ?? null, m.durationSec ?? null, m.sizeMb ?? null).run();
  }
}

async function saveQueueItem(env: Env, data: {
  itemId: string; channelId: string; language: string; sourceUrl: string;
  captionShort: string; captionFull: string; hashtags: string[];
  method: string; mediaUrls: string[]; mediaTypes: Array<'image'|'video'>;
  scheduledAt: number;
}): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO publish_queue
    (id,item_id,channel_id,language,source_url,caption_short,caption_full,hashtags,
     telegram_method,media_urls,media_types,scheduled_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    generateId('q'), data.itemId, data.channelId, data.language, data.sourceUrl,
    data.captionShort, data.captionFull, JSON.stringify(data.hashtags),
    data.method, JSON.stringify(data.mediaUrls), JSON.stringify(data.mediaTypes),
    data.scheduledAt
  ).run();
}

async function getSetting(env: Env, key: string): Promise<string> {
  try {
    const r = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first<{ value: string }>();
    return r?.value ?? '';
  } catch { return ''; }
}

// ── Utils ─────────────────────────────────────────────────────

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function mkResult(
  runId: string, categoryId: string, platform: string,
  ok: boolean, dryRun: boolean, p: Partial<CurationRunResult> = {}
): CurationRunResult {
  return {
    runId, categoryId, platform, ok, dryRun,
    itemsFetched:    p.itemsFetched    ?? 0,
    itemsNew:        p.itemsNew        ?? 0,
    itemsDuplicate:  p.itemsDuplicate  ?? 0,
    itemsAiSelected: p.itemsAiSelected ?? 0,
    itemsAiRejected: p.itemsAiRejected ?? 0,
    itemsQueued:     p.itemsQueued     ?? 0,
    errors:          p.errors          ?? [],
    durationMs:      p.durationMs      ?? 0,
  };
}
