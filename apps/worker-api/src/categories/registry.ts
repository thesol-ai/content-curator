import type { CategoryPolicy, CategorySourceStrategy } from './types';
import { defaultCategoryPolicy } from './default/policy';
import { defaultSourceStrategy } from './default/sources';
import { cryptoPolicy } from './crypto/policy';
import { moviePolicy } from './movie/policy';
import { gamingPolicy } from './gaming/policy';
import { aiCategoryPolicy } from './ai/policy';
import { cryptoSourceStrategy } from './crypto/sources';
import { movieSourceStrategy } from './movie/sources';
import { gamingSourceStrategy } from './gaming/sources';
import { aiSourceStrategy } from './ai/sources';

const DEFAULT_POLICY: CategoryPolicy = defaultCategoryPolicy;

const POLICIES: Record<string, CategoryPolicy> = {
  crypto: cryptoPolicy,
  movie: moviePolicy,
  gaming: gamingPolicy,
  ai: aiCategoryPolicy,
};

const DEFAULT_SOURCE_STRATEGY: CategorySourceStrategy = defaultSourceStrategy;

const SOURCE_STRATEGIES: Record<string, CategorySourceStrategy> = {
  crypto: cryptoSourceStrategy,
  movie: movieSourceStrategy,
  gaming: gamingSourceStrategy,
  ai: aiSourceStrategy,
};

export function getCategoryPolicy(categoryId: unknown): CategoryPolicy {
  const id = String(categoryId ?? '').trim().toLowerCase();
  return POLICIES[id] ?? DEFAULT_POLICY;
}

export function getCategorySourceStrategy(categoryId: unknown): CategorySourceStrategy {
  const id = String(categoryId ?? '').trim().toLowerCase();
  return SOURCE_STRATEGIES[id] ?? DEFAULT_SOURCE_STRATEGY;
}

