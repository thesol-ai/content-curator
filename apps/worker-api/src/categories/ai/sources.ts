import type {
  ApifyRotationPlan,
  ApifyRotationSourceRow,
  CategorySourceStrategy,
} from '../types';

export const AI_DISABLED_SOURCE_IDS = new Set([
  'src_ai_x_news_text',
]);

export const aiSourceStrategy: CategorySourceStrategy = {
  id: 'ai',

  canHandleSource: (_source: ApifyRotationSourceRow) => false,

  buildRotationPlan: (_source: ApifyRotationSourceRow, _bucket: number): ApifyRotationPlan | null => {
    return null;
  },

  buildRotationAttempts: () => [],
};
