import type { CategoryRow, NormalizedItem } from '../types';

export interface CategoryPolicy {
  id: string;
  getPreAiRejectReason?: (item: NormalizedItem, category: CategoryRow) => string | null;
  buildScoringPolicy?: (category: CategoryRow) => string;
}
