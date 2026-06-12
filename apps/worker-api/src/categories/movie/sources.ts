import type {
  ApifyRotationPlan,
  ApifyRotationSourceRow,
  CategorySourceStrategy,
} from '../types';

export const MOVIE_DISABLED_SOURCE_IDS = new Set([
  'src_movie_x_news_text',
]);

export const movieSourceStrategy: CategorySourceStrategy = {
  id: 'movie',

  canHandleSource: (_source: ApifyRotationSourceRow) => false,

  buildRotationPlan: (_source: ApifyRotationSourceRow, _bucket: number): ApifyRotationPlan | null => {
    return null;
  },

  buildRotationAttempts: () => [],
};
