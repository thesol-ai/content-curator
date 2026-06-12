import type { CategoryRow } from '../../types';

export function buildGamingScoringPolicy(_category: CategoryRow): string {
  return [
    'GAMING CATEGORY GUIDANCE:',
    'Prefer concrete gaming news, studio updates, releases, patches, platform changes, esports developments, reviews, or industry analysis.',
    'Reward posts with named games, studios, platforms, release timing, business impact, player impact, or technical relevance.',
    'Reject generic memes, engagement bait, giveaway spam, and posts with no gaming substance.',
    'Do not apply crypto-specific hard gates, market commentary rules, token rules, or blockchain relevance requirements.',
  ].join(' ');
}
