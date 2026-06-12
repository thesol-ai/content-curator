import type {
  ApifyRotationPlan,
  ApifyRotationSourceRow,
  CategorySourceStrategy,
} from '../types';

export const GAMING_DISABLED_SOURCE_IDS = new Set([
  'src_gaming_x_news_text',
]);

export const gamingSourceStrategy: CategorySourceStrategy = {
  id: 'gaming',

  canHandleSource: (_source: ApifyRotationSourceRow) => false,

  buildRotationPlan: (_source: ApifyRotationSourceRow, _bucket: number): ApifyRotationPlan | null => {
    return null;
  },

  buildRotationAttempts: () => [],
};
