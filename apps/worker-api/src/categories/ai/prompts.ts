import type { CategoryRow } from '../../types';

export function buildAiScoringPolicy(_category: CategoryRow): string {
  return [
    'ARTIFICIAL INTELLIGENCE CATEGORY GUIDANCE:',
    'Prefer concrete AI model, research, product, benchmark, safety, infrastructure, policy, or industry developments.',
    'Reward posts with named models, labs, papers, benchmark results, product launches, regulation, deployment details, or practical AI impact.',
    'Reject vague hype, generic productivity tips, prompt spam, and posts with no verifiable AI substance.',
    'Do not apply crypto-specific hard gates, market commentary rules, token rules, or blockchain relevance requirements.',
  ].join(' ');
}
