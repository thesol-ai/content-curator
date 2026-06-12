import type { CategoryPolicy } from './types';
import { cryptoPolicy } from './crypto/policy';

const DEFAULT_POLICY: CategoryPolicy = {
  id: 'default',
};

const POLICIES: Record<string, CategoryPolicy> = {
  crypto: cryptoPolicy,
};

export function getCategoryPolicy(categoryId: unknown): CategoryPolicy {
  const id = String(categoryId ?? '').trim().toLowerCase();
  return POLICIES[id] ?? DEFAULT_POLICY;
}
