// ══════════════════════════════════════════════════════════════
// services/rule-gate.ts
// فیلتر قطعی — بررسی quota، time window، و تعیین scheduled_at
// ══════════════════════════════════════════════════════════════

import type { Env, AIGateResult, ChannelRow, PublishPriority } from '../types';

export interface RuleGateResult {
  approved: boolean;
  reason?: string;
  scheduledAt?: number; // unix timestamp
}

export async function runRuleGate(
  env: Env,
  aiResult: AIGateResult,
  channel: ChannelRow,
  mediaUrlExpiresSoon: boolean = false
): Promise<RuleGateResult> {
  // ۱. AI gate pass کرده؟
  if (!aiResult.publish) {
    return { approved: false, reason: `ai_rejected:score=${aiResult.score}` };
  }

  // ۲. Risk
  if (aiResult.riskLevel === 'high') {
    return { approved: false, reason: 'high_risk' };
  }

  // ۳. Translation for this channel's language موجود است؟
  if (!aiResult.translations[channel.language]) {
    return { approved: false, reason: `no_translation_for_${channel.language}` };
  }

  // ۴. Daily quota
  const todayStart = getStartOfDay();
  const publishedToday = await env.DB
    .prepare(`
      SELECT COUNT(*) as cnt FROM publish_queue
      WHERE channel_id = ? AND status = 'published'
        AND published_at > ?
    `)
    .bind(channel.id, todayStart)
    .first<{ cnt: number }>();

  if ((publishedToday?.cnt ?? 0) >= channel.max_per_day) {
    return { approved: false, reason: 'daily_quota_exceeded' };
  }

  // ۵. تعیین scheduled_at
  const scheduledAt = computeScheduledAt(aiResult.publishPriority, channel, mediaUrlExpiresSoon);

  return { approved: true, scheduledAt };
}

// ── Compute when to publish based on priority ─────────────────
// mediaUrlExpiresSoon=true → حداکثر ۲ ساعت تأخیر (Instagram/LinkedIn CDN)

function computeScheduledAt(
  priority: PublishPriority,
  _channel: ChannelRow,
  mediaUrlExpiresSoon: boolean
): number {
  const now = Math.floor(Date.now() / 1000);

  if (mediaUrlExpiresSoon) {
    // CDN URLs expire می‌شوند — حداکثر ۲ ساعت فاصله
    switch (priority) {
      case 'breaking': return now + 5 * 60;        // ۵ دقیقه
      case 'high':     return now + 20 * 60;        // ۲۰ دقیقه
      default:         return now + 60 * 60;        // ۱ ساعت
    }
  }

  switch (priority) {
    case 'breaking': return now + 5 * 60;           // ۵ دقیقه
    case 'high':     return now + 60 * 60;          // ۱ ساعت
    case 'normal':   return now + 2 * 60 * 60;      // ۲ ساعت
    case 'low':      return now + 6 * 60 * 60;      // ۶ ساعت
    default:         return now + 2 * 60 * 60;
  }
}

function getStartOfDay(): number {
  const now = new Date();
  return Math.floor(
    new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000
  );
}
