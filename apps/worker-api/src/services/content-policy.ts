import type { AIGateResult, CategoryRow, NormalizedItem } from '../types';

export function findSimilarTopicInRunRejections(
  items: Pick<NormalizedItem, 'sourceAccount'>[],
  aiResults: Pick<AIGateResult, 'publish' | 'riskLevel' | 'score' | 'topicFingerprint'>[],
  scoreThreshold: number,
): Set<number> {
  const groups = new Map<string, Array<{ index: number; score: number }>>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const ai = aiResults[i];
    if (!item || !ai) continue;
    if (!isAiPublishEligible(ai, scoreThreshold)) continue;

    const fingerprint = normalizeSemanticKeyPart(ai.topicFingerprint);
    if (!fingerprint) continue;

    const key = fingerprint;
    const group = groups.get(key) ?? [];
    group.push({ index: i, score: Number(ai.score) || 0 });
    groups.set(key, group);
  }

  const rejected = new Set<number>();
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    const [winner, ...rest] = group
      .slice()
      .sort((a, b) => (b.score - a.score) || (a.index - b.index));
    void winner;
    for (const candidate of rest) rejected.add(candidate.index);
  }
  return rejected;
}

export function getPreAiContentRejectReason(item: NormalizedItem, category: CategoryRow): string | null {
  if (item.isReply === true && intSetting(category.allow_replies, 0) === 0) return 'reply_not_allowed';
  if (item.isRetweet === true && intSetting(category.allow_retweets, 1) === 0) return 'retweet_not_allowed';
  if (item.isQuote === true && intSetting(category.allow_quotes, 1) === 0) return 'quote_not_allowed';
  const textOnlyPolicy = sanitizeTextOnlyPolicy(category.text_only_policy);
  if (category.media_mode !== 'disabled' && item.media.length === 0 && textOnlyPolicy === 'reject') return 'text_only_rejected';
  return null;
}

export function getItemRejectReason(ai: AIGateResult, category: CategoryRow, item: NormalizedItem, similarTopicInRun: boolean): string | null {
  if (similarTopicInRun) return 'similar_topic_in_run';
  if (!ai.publish) return 'ai_not_publish';
  if (ai.riskLevel === 'high') return 'high_risk';
  if (ai.score < category.score_threshold) return 'below_threshold';

  const textOnlyPolicy = sanitizeTextOnlyPolicy(category.text_only_policy);
  if (category.media_mode !== 'disabled' && item.media.length === 0) {
    const minTextOnly = Number(category.min_score_for_text_only);
    if (textOnlyPolicy === 'penalize' && Number.isFinite(minTextOnly) && ai.score < minTextOnly) return 'text_only_below_min_score';
  }
  if (item.media.length > 0) {
    const minMedia = Number(category.min_score_for_media);
    if (Number.isFinite(minMedia) && ai.score < minMedia) return 'media_below_min_score';
  }
  return null;
}

export function buildPolicyRejectAiResult(item: NormalizedItem, reason: string): AIGateResult {
  return {
    publish: false,
    score: 0,
    riskLevel: 'medium',
    riskFlags: [reason],
    topicFingerprint: `policy-${item.postId}`.slice(0, 100),
    publishPriority: 'low',
    translations: {},
  };
}

function isAiPublishEligible(
  ai: Pick<AIGateResult, 'publish' | 'riskLevel' | 'score'>,
  scoreThreshold: number,
): boolean {
  return ai.publish === true && ai.riskLevel !== 'high' && Number(ai.score) >= scoreThreshold;
}

function normalizeSemanticKeyPart(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/\s+/g, ' ')
    .slice(0, 140);
}

function intSetting(value: unknown, defaultValue: 0 | 1): 0 | 1 {
  return value === 0 || value === '0' || value === false ? 0 : value === 1 || value === '1' || value === true ? 1 : defaultValue;
}

function sanitizeTextOnlyPolicy(value: unknown): 'allow' | 'penalize' | 'reject' {
  const raw = String(value ?? 'allow').trim().toLowerCase();
  return raw === 'penalize' || raw === 'reject' ? raw : 'allow';
}
