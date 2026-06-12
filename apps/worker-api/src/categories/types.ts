import type { CategoryRow, NormalizedItem } from '../types';

export interface CategoryPolicy {
  id: string;
  getPreAiRejectReason?: (item: NormalizedItem, category: CategoryRow) => string | null;
  buildScoringPolicy?: (category: CategoryRow) => string;
}

export interface ApifyRotationSourceRow {
  id: string;
  label: string | null;
  category_id: string;
  platform: string;
  apify_task_id: string | null;
}

export type ApifyRotationMode = 'media' | 'text' | 'default';

export interface ApifyRotationPlan {
  source: ApifyRotationSourceRow;
  cohortName: string;
  cohortIndex: number | null;
  accounts: string[];
  inputOverride: Record<string, unknown>;
}

export interface ApifyRotationAttemptPlan {
  attempt: string;
  inputOverride: Record<string, unknown>;
  reason?: string;
}

export interface CategorySourceStrategy {
  id: string;
  canHandleSource: (source: ApifyRotationSourceRow) => boolean;
  buildRotationPlan: (source: ApifyRotationSourceRow, bucket: number) => ApifyRotationPlan | null;
  buildRotationAttempts?: (plan: ApifyRotationPlan) => ApifyRotationAttemptPlan[];
}

