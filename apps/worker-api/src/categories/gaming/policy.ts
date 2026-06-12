import type { CategoryPolicy } from '../types';
import { buildGamingScoringPolicy } from './prompts';

export const gamingPolicy: CategoryPolicy = {
  id: 'gaming',
  buildScoringPolicy: (category) => buildGamingScoringPolicy(category),
};
