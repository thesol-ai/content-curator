import type { CategoryPolicy, CategorySourceStrategy } from './types';
import { defaultCategoryPolicy } from './default/policy';
import { defaultSourceStrategy } from './default/sources';
import { cryptoPolicy } from './crypto/policy';
import { cryptoSourceStrategy } from './crypto/sources';

const DEFAULT_POLICY: CategoryPolicy = defaultCategoryPolicy;

const POLICIES: Record<string, CategoryPolicy> = {
  crypto: cryptoPolicy,
};

const DEFAULT_SOURCE_STRATEGY: CategorySourceStrategy = defaultSourceStrategy;

const SOURCE_STRATEGIES: Record<string, CategorySourceStrategy> = {
  crypto: cryptoSourceStrategy,
};

export function getCategoryPolicy(categoryId: unknown): CategoryPolicy {
  const id = String(categoryId ?? '').trim().toLowerCase();
  return POLICIES[id] ?? DEFAULT_POLICY;
}

export function getCategorySourceStrategy(categoryId: unknown): CategorySourceStrategy {
  const id = String(categoryId ?? '').trim().toLowerCase();
  return SOURCE_STRATEGIES[id] ?? DEFAULT_SOURCE_STRATEGY;
}

