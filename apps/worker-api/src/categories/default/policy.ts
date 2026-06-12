import type { CategoryPolicy } from '../types';
import { buildDefaultScoringPolicy } from './prompts';

export const defaultCategoryPolicy: CategoryPolicy = {
  id: 'default',
  buildScoringPolicy: (category) => buildDefaultScoringPolicy(category),
};
