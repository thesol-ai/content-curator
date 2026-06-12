import type { CategoryRow } from '../../types';

export function buildMovieScoringPolicy(_category: CategoryRow): string {
  return [
    'MOVIES & CINEMA CATEGORY GUIDANCE:',
    'Prefer concrete movie, cinema, trailer, casting, box-office, festival, production, distribution, or review/news items.',
    'Reward posts with clear entertainment/news value, named works, named studios, release timing, or measurable audience/industry impact.',
    'Reject vague celebrity gossip, generic fan engagement bait, and posts with no film/cinema substance.',
    'Do not apply crypto-specific hard gates, market commentary rules, token rules, or blockchain relevance requirements.',
  ].join(' ');
}
