import type { CategorySourceStrategy } from '../types';

export const defaultSourceStrategy: CategorySourceStrategy = {
  id: 'default',
  canHandleSource: () => false,
  buildRotationPlan: () => null,
  buildRotationAttempts: () => [],
};
