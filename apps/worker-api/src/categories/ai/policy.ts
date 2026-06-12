import type { CategoryPolicy } from '../types';
import { buildAiScoringPolicy } from './prompts';

export const aiCategoryPolicy: CategoryPolicy = {
  id: 'ai',
  buildScoringPolicy: (category) => buildAiScoringPolicy(category),
};
