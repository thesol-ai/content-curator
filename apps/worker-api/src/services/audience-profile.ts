// ══════════════════════════════════════════════════════════════
// services/audience-profile.ts
// Next phase (6J) — locale/audience-aware SELECTION guidance for the AI
// scoring stage. The 72h evidence shows the volume ceiling is the scoring
// stage ("ai_not_publish" ≈ 65% of gated items) and the operator wants Claude
// to pick the best posts *for a specific audience* (currently Iranian/Persian),
// with Arabic / English / Russian audiences each optimised separately later.
//
// This module is the extensible registry for that. It only ADDS guidance to
// the scoring system prompt (it never changes the numeric threshold), and it
// is feature-flagged so default behavior is unchanged until opted in.
// ══════════════════════════════════════════════════════════════

import type { Env } from '../types';

export interface AudienceProfile {
  /** language/region key, e.g. "fa" */
  key: string;
  /** human label for logs/reports */
  label: string;
  /** guidance block injected into the scoring system prompt */
  guidance: string;
}

// ── Iranian / Persian crypto-Telegram audience (active) ───────────────────
// Derived from the project brief + 72h production evidence (whale-transfer
// speculation and US-equity/SPCX hype were repeatedly low-value / manually
// cancelled; security & access-relevant news is high value).
const FA_PROFILE: AudienceProfile = {
  key: 'fa',
  label: 'Iranian / Persian crypto audience',
  guidance: [
    'AUDIENCE PROFILE — Iranian Persian-speaking crypto users (rank relevance for THIS audience; do not change the numeric threshold, only how well an item serves this audience):',
    'PRIORITISE (higher score when the source supports it):',
    '- Concrete market-moving events: major BTC/ETH/stablecoin moves, large ETF in/outflows with figures, listings/delistings, protocol upgrades, hacks/exploits with confirmed amounts.',
    '- Security & scam alerts (phishing, drainers, exchange incidents, stablecoin freezes) — highly valued by this audience.',
    '- Regulation/policy that plausibly affects access for non-US users: stablecoin rules, exchange/KYC policy, sanctions-adjacent or cross-border payment news.',
    '- Practical, verifiable, self-contained items that need no external context.',
    'DEPRIORITISE (lower score / usually do not publish):',
    '- US-equity-only or pre-IPO/SpaceX-SPCX hype with no clear crypto-market consequence for ordinary users.',
    '- Pure whale-transfer "X coins moved" posts whose only takeaway is speculation ("could indicate ...") with no confirmed consequence.',
    '- Promotional/airdrop/trading-competition/marketing posts and official-account self-promotion with low news value.',
    '- US-domestic politics or macro commentary with no direct crypto impact.',
    'Judge relevance from the SOURCE TEXT only; never invent an Iran angle that is not present.',
  ].join('\n'),
};

// Registry. Arabic / English / Russian are intentionally placeholders so they
// can be optimised separately later (the operator stated this is coming). Until
// a real profile is written they fall back to null (no extra guidance), which
// preserves today's behavior for those locales.
const AUDIENCE_PROFILES: Record<string, AudienceProfile> = {
  fa: FA_PROFILE,
  // ar: { key: 'ar', label: 'Arabic crypto audience', guidance: '...' },
  // en: { key: 'en', label: 'English crypto audience', guidance: '...' },
  // ru: { key: 'ru', label: 'Russian crypto audience', guidance: '...' },
};

export function isAudienceProfileScoringEnabled(env: Env): boolean {
  return String((env as any).AUDIENCE_PROFILE_SCORING_ENABLED ?? '').toLowerCase() === 'true';
}

/** Normalise a language/region token like "fa-IR" or "FA" → "fa". */
export function normalizeAudienceKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? '';
}

/** Pure: return the guidance block for a language key, or null if none. */
export function getAudienceProfileGuidance(languageOrRegion: unknown): string | null {
  const key = normalizeAudienceKey(languageOrRegion);
  const profile = AUDIENCE_PROFILES[key];
  return profile ? profile.guidance : null;
}

/** Pure: pick the primary audience key from the category's language targets. */
export function primaryAudienceKey(languageTargets: string[] | undefined | null): string {
  if (Array.isArray(languageTargets) && languageTargets.length > 0) {
    return normalizeAudienceKey(languageTargets[0]);
  }
  return 'fa';
}
