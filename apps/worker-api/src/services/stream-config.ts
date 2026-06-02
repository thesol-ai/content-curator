// ══════════════════════════════════════════════════════════════
// services/stream-config.ts
// Centralized Cloudflare Stream safety gate.
//
// Phase 1 rule:
//   Cloudflare Stream is paid/optional and must never be called just
//   because credentials exist. It requires an explicit enable flag too.
// ══════════════════════════════════════════════════════════════

import type { Env } from '../types';

export interface StreamTranscodeState {
  /** True only when explicitly enabled and fully configured. */
  enabled: boolean;
  /** STREAM_TRANSCODE_ENABLED=true */
  explicitlyEnabled: boolean;
  /** Both account ID and API token are present. */
  configured: boolean;
  hasAccountId: boolean;
  hasApiToken: boolean;
  reason: string;
}

export function getStreamTranscodeState(env: Env): StreamTranscodeState {
  const explicitlyEnabled = env.STREAM_TRANSCODE_ENABLED === 'true';
  const hasAccountId = Boolean(env.CLOUDFLARE_ACCOUNT_ID?.trim());
  const hasApiToken = Boolean(env.CLOUDFLARE_STREAM_API_TOKEN?.trim());
  const configured = hasAccountId && hasApiToken;

  if (!explicitlyEnabled) {
    return {
      enabled: false,
      explicitlyEnabled,
      configured,
      hasAccountId,
      hasApiToken,
      reason: 'STREAM_TRANSCODE_ENABLED is not true',
    };
  }

  if (!configured) {
    const missing = [
      hasAccountId ? '' : 'CLOUDFLARE_ACCOUNT_ID',
      hasApiToken ? '' : 'CLOUDFLARE_STREAM_API_TOKEN',
    ].filter(Boolean).join(', ');

    return {
      enabled: false,
      explicitlyEnabled,
      configured,
      hasAccountId,
      hasApiToken,
      reason: `missing ${missing}`,
    };
  }

  return {
    enabled: true,
    explicitlyEnabled,
    configured,
    hasAccountId,
    hasApiToken,
    reason: 'enabled',
  };
}
