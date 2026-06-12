import type { CategoryPolicy } from '../types';
import { buildMovieScoringPolicy } from './prompts';

export const moviePolicy: CategoryPolicy = {
  id: 'movie',
  buildScoringPolicy: (category) => buildMovieScoringPolicy(category),
};
