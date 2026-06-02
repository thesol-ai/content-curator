// ══════════════════════════════════════════════════════════════
// services/rule-gate.ts
// فیلتر قطعی — بررسی quota، time window، timezone، و تعیین scheduled_at
//
// Phase 2 scope:
//   ✓ محاسبه timezone-aware برای روز کانال
//   ✓ پشتیبانی از allowed/blocked windows عادی و overnight
//   ✓ blocked_windows نسبت به allowed_windows اولویت عملیاتی دارد
//   ✓ quota بر اساس روز محلی همان scheduled_at حساب می‌شود
//   ✓ scheduled/retry/publishing items در daily quota لحاظ می‌شوند
//   ✓ min_gap_minutes هنگام ساخت schedule اعمال می‌شود
// ══════════════════════════════════════════════════════════════

import type { Env, AIGateResult, ChannelRow, PublishPriority } from '../types';

export interface RuleGateResult {
  approved: boolean;
  reason?: string;
  scheduledAt?: number; // unix timestamp
}

interface TimeWindow {
  startMin: number; // minute from local midnight, inclusive
  endMin: number;   // minute from local midnight, exclusive by convention
  raw: string;
}

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

interface UnixInterval {
  start: number;
  end: number;
  window: TimeWindow;
}

export async function runRuleGate(
  env: Env,
  aiResult: AIGateResult,
  channel: ChannelRow,
  mediaUrlExpiresSoon: boolean = false
): Promise<RuleGateResult> {
  if (!aiResult.publish) {
    return { approved: false, reason: `ai_rejected:score=${aiResult.score}` };
  }

  if (aiResult.riskLevel === 'high') {
    return { approved: false, reason: 'high_risk' };
  }

  if (!aiResult.translations[channel.language]) {
    return { approved: false, reason: `no_translation_for_${channel.language}` };
  }

  const lastScheduled = await env.DB
    .prepare(`
      SELECT MAX(scheduled_at) as last_at FROM publish_queue
      WHERE channel_id = ? AND status IN ('scheduled', 'retry', 'publishing', 'published')
    `)
    .bind(channel.id)
    .first<{ last_at: number | null }>();

  const scheduledAt = computeScheduledAt(
    aiResult.publishPriority,
    channel,
    mediaUrlExpiresSoon,
    lastScheduled?.last_at ?? null
  );

  const dayBounds = getChannelDayBoundsForUnix(scheduledAt, channel.timezone);

  const publishedForDay = await env.DB
    .prepare(`
      SELECT COUNT(*) as cnt FROM publish_queue
      WHERE channel_id = ? AND status = 'published'
        AND published_at >= ? AND published_at < ?
    `)
    .bind(channel.id, dayBounds.startUnix, dayBounds.endUnix)
    .first<{ cnt: number }>();

  const scheduledForDay = await env.DB
    .prepare(`
      SELECT COUNT(*) as cnt FROM publish_queue
      WHERE channel_id = ? AND status IN ('scheduled', 'retry', 'publishing')
        AND scheduled_at >= ? AND scheduled_at < ?
    `)
    .bind(channel.id, dayBounds.startUnix, dayBounds.endUnix)
    .first<{ cnt: number }>();

  const totalForDay = (publishedForDay?.cnt ?? 0) + (scheduledForDay?.cnt ?? 0);
  if (totalForDay >= channel.max_per_day) {
    return {
      approved: false,
      reason: `daily_quota_exceeded:${totalForDay}/${channel.max_per_day}`,
    };
  }

  return { approved: true, scheduledAt };
}

function computeScheduledAt(
  priority: PublishPriority,
  channel: ChannelRow,
  mediaUrlExpiresSoon: boolean,
  lastScheduledAt: number | null
): number {
  const now = Math.floor(Date.now() / 1000);
  let candidateUnix = now + baseDelaySeconds(priority, mediaUrlExpiresSoon);

  if (channel.min_gap_minutes > 0 && lastScheduledAt !== null) {
    const minNextAt = lastScheduledAt + channel.min_gap_minutes * 60;
    if (minNextAt > candidateUnix) candidateUnix = minNextAt;
  }

  const allowedWindows = safeParseWindows(channel.allowed_windows);
  const blockedWindows = safeParseWindows(channel.blocked_windows);

  return normalizeToChannelWindows(candidateUnix, channel.timezone, allowedWindows, blockedWindows);
}

function baseDelaySeconds(priority: PublishPriority, mediaUrlExpiresSoon: boolean): number {
  if (mediaUrlExpiresSoon) {
    switch (priority) {
      case 'breaking': return 5 * 60;
      case 'high': return 20 * 60;
      default: return 60 * 60;
    }
  }

  switch (priority) {
    case 'breaking': return 5 * 60;
    case 'high': return 60 * 60;
    case 'normal': return 2 * 60 * 60;
    case 'low': return 6 * 60 * 60;
    default: return 2 * 60 * 60;
  }
}

function normalizeToChannelWindows(
  candidateUnix: number,
  timezone: string,
  allowedWindows: TimeWindow[],
  blockedWindows: TimeWindow[]
): number {
  let candidate = candidateUnix;

  for (let attempt = 0; attempt < 10; attempt++) {
    const before = candidate;

    if (allowedWindows.length > 0) {
      candidate = adjustForAllowedWindows(candidate, timezone, allowedWindows);
    }

    if (blockedWindows.length > 0) {
      candidate = adjustForBlockedWindows(candidate, timezone, blockedWindows);
    }

    if (candidate === before) return candidate;
  }

  return candidate;
}

function adjustForAllowedWindows(
  candidateUnix: number,
  timezone: string,
  allowedWindows: TimeWindow[]
): number {
  const intervals = expandWindowIntervalsAround(candidateUnix, timezone, allowedWindows, 1, 8);

  if (isInAnyInterval(candidateUnix, intervals)) return candidateUnix;

  const next = intervals
    .filter(interval => interval.start >= candidateUnix)
    .sort((a, b) => a.start - b.start)[0];

  return next?.start ?? candidateUnix;
}

function adjustForBlockedWindows(
  candidateUnix: number,
  timezone: string,
  blockedWindows: TimeWindow[]
): number {
  let candidate = candidateUnix;

  for (let attempt = 0; attempt < 10; attempt++) {
    const intervals = expandWindowIntervalsAround(candidate, timezone, blockedWindows, 1, 2);
    const current = intervals.find(interval => candidate >= interval.start && candidate < interval.end);
    if (!current) return candidate;
    candidate = current.end;
  }

  return candidate;
}

function isInAnyInterval(unixTs: number, intervals: UnixInterval[]): boolean {
  return intervals.some(interval => unixTs >= interval.start && unixTs < interval.end);
}

function expandWindowIntervalsAround(
  unixTs: number,
  timezone: string,
  windows: TimeWindow[],
  daysBefore: number,
  daysAfter: number
): UnixInterval[] {
  const local = getZonedDateParts(new Date(unixTs * 1000), timezone);
  const intervals: UnixInterval[] = [];

  for (let dayOffset = -daysBefore; dayOffset <= daysAfter; dayOffset++) {
    const startDate = addDaysToLocalDate(local.year, local.month, local.day, dayOffset);

    for (const window of windows) {
      const start = localDateMinuteToUnix(timezone, startDate.year, startDate.month, startDate.day, window.startMin);
      const endDate = window.endMin > window.startMin
        ? startDate
        : addDaysToLocalDate(startDate.year, startDate.month, startDate.day, 1);
      const end = localDateMinuteToUnix(timezone, endDate.year, endDate.month, endDate.day, window.endMin);

      if (end > start) intervals.push({ start, end, window });
    }
  }

  return intervals.sort((a, b) => a.start - b.start);
}

function getChannelDayBoundsForUnix(unixTs: number, timezone: string): { startUnix: number; endUnix: number } {
  const local = getZonedDateParts(new Date(unixTs * 1000), timezone);
  const startUnix = zonedLocalToUnix(timezone, local.year, local.month, local.day, 0, 0, 0);
  const tomorrow = addDaysToLocalDate(local.year, local.month, local.day, 1);
  const endUnix = zonedLocalToUnix(timezone, tomorrow.year, tomorrow.month, tomorrow.day, 0, 0, 0);
  return { startUnix, endUnix };
}

function localDateMinuteToUnix(
  timezone: string,
  year: number,
  month: number,
  day: number,
  minuteOfDay: number
): number {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return zonedLocalToUnix(timezone, year, month, day, hour, minute, 0);
}

function getZonedDateParts(date: Date, timezone: string): LocalDateParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimezone(timezone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(date);
  const get = (type: string): number => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function zonedLocalToUnix(
  timezone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): number {
  const tz = safeTimezone(timezone);
  const localAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  let utcMs = localAsUtcMs;

  // Iterate because timezone offset may differ around DST boundaries.
  for (let i = 0; i < 4; i++) {
    const offsetMinutes = getTimezoneOffsetMinutes(new Date(utcMs), tz);
    const nextUtcMs = localAsUtcMs - offsetMinutes * 60_000;
    if (Math.abs(nextUtcMs - utcMs) < 1000) {
      utcMs = nextUtcMs;
      break;
    }
    utcMs = nextUtcMs;
  }

  return Math.floor(utcMs / 1000);
}

function getTimezoneOffsetMinutes(date: Date, timezone: string): number {
  const parts = getZonedDateParts(date, timezone);
  const localAsUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return Math.round((localAsUtcMs - date.getTime()) / 60_000);
}

function safeTimezone(timezone: string): string {
  const candidate = timezone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return 'UTC';
  }
}

function addDaysToLocalDate(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function parseWindow(windowStr: string): TimeWindow | null {
  const m = windowStr.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (!m) return null;

  const startHour = parseInt(m[1]!, 10);
  const startMinute = parseInt(m[2]!, 10);
  const endHour = parseInt(m[3]!, 10);
  const endMinute = parseInt(m[4]!, 10);

  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) return null;

  const startMin = startHour * 60 + startMinute;
  const endMin = endHour * 60 + endMinute;

  if (startMin === endMin) return null;

  return { startMin, endMin, raw: windowStr };
}

function safeParseWindows(jsonStr: string): TimeWindow[] {
  try {
    const arr: unknown = JSON.parse(jsonStr);
    if (!Array.isArray(arr)) return [];
    return arr.map(w => typeof w === 'string' ? parseWindow(w) : null).filter((w): w is TimeWindow => w !== null);
  } catch {
    return [];
  }
}

// Test-only exports. These are pure helpers and do not change runtime behavior.
export const __ruleGateTest = {
  parseWindow,
  safeParseWindows,
  getChannelDayBoundsForUnix,
  normalizeToChannelWindows,
  zonedLocalToUnix,
  getZonedDateParts,
};
