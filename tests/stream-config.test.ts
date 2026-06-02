import { describe, expect, it } from 'vitest';
import { getStreamTranscodeState } from '../apps/worker-api/src/services/stream-config';
import type { Env } from '../apps/worker-api/src/types';

function env(overrides: Partial<Env> = {}): Env {
  return { DB: {}, ...overrides } as Env;
}

describe('Cloudflare Stream safety gate', () => {
  it('stays disabled by default even when Stream credentials exist', () => {
    const state = getStreamTranscodeState(env({
      CLOUDFLARE_ACCOUNT_ID: 'account-id',
      CLOUDFLARE_STREAM_API_TOKEN: 'token',
    }));

    expect(state).toMatchObject({
      enabled: false,
      explicitlyEnabled: false,
      configured: true,
      hasAccountId: true,
      hasApiToken: true,
    });
    expect(state.reason).toContain('STREAM_TRANSCODE_ENABLED');
  });

  it('only enables Stream when explicitly enabled and fully configured', () => {
    const state = getStreamTranscodeState(env({
      STREAM_TRANSCODE_ENABLED: 'true',
      CLOUDFLARE_ACCOUNT_ID: 'account-id',
      CLOUDFLARE_STREAM_API_TOKEN: 'token',
    }));

    expect(state).toMatchObject({
      enabled: true,
      explicitlyEnabled: true,
      configured: true,
      reason: 'enabled',
    });
  });

  it('does not enable Stream when the explicit flag is true but credentials are missing', () => {
    const state = getStreamTranscodeState(env({ STREAM_TRANSCODE_ENABLED: 'true' }));

    expect(state.enabled).toBe(false);
    expect(state.explicitlyEnabled).toBe(true);
    expect(state.configured).toBe(false);
    expect(state.reason).toContain('missing');
  });
});
