import { describe, expect, it } from 'vitest';
import { isQueuePolicyEnforcementEnabled } from '../apps/worker-api/src/services/queue-policy';
import type { Env } from '../apps/worker-api/src/types';

describe('queue policy feature flag', () => {
  it('is disabled when the environment variable is absent', () => {
    expect(isQueuePolicyEnforcementEnabled({} as Env)).toBe(false);
  });

  it('is enabled only by explicit opt-in', () => {
    expect(isQueuePolicyEnforcementEnabled({
      QUEUE_POLICY_ENFORCEMENT_ENABLED: 'true',
    } as Env)).toBe(true);
  });

  it('stays disabled for an explicit false value', () => {
    expect(isQueuePolicyEnforcementEnabled({
      QUEUE_POLICY_ENFORCEMENT_ENABLED: 'false',
    } as Env)).toBe(false);
  });
});
