import { describe, expect, it } from 'vitest';

import {
  classifyTranslationFailureReason,
} from '../apps/worker-api/src/services/ai-gate';

import {
  getTerminalTranslationRejectReason,
} from '../apps/worker-api/src/services/backlog-drain';

import type {
  AIGateResult,
  Env,
} from '../apps/worker-api/src/types';

function aiWithTerminalReason(
  reason?: string,
): AIGateResult {
  return {
    publish: false,
    score: 90,
    riskLevel: 'low',
    riskFlags: ['translation_missing'],
    topicFingerprint: 'bitcoin-etf-flow',
    publishPriority: 'normal',
    translations: {},
    translationTerminalReason: reason ?? null,
  };
}

describe('terminal factual caption rejection', () => {
  it('requires a completed in-request repair', () => {
    expect(
      classifyTranslationFailureReason(
        'caption_unsupported_exact_figure',
        false,
      ),
    ).toBe('transient');

    expect(
      classifyTranslationFailureReason(
        'caption_unsupported_exact_figure',
        true,
      ),
    ).toBe('terminal');

    expect(
      classifyTranslationFailureReason(
        'caption_unsupported_number:42',
        true,
      ),
    ).toBe('terminal');
  });

  it('keeps temporary, structural, and stylistic failures retryable', () => {
    expect(
      classifyTranslationFailureReason(
        'translation_invalid_json',
        true,
      ),
    ).toBe('transient');

    expect(
      classifyTranslationFailureReason(
        'rtl_repair_failed',
        true,
      ),
    ).toBe('transient');

    expect(
      classifyTranslationFailureReason(
        'caption_title_mismatch',
        true,
      ),
    ).toBe('transient');

    expect(
      classifyTranslationFailureReason(
        'caption_quality_low',
        true,
      ),
    ).toBe('transient');

    expect(
      classifyTranslationFailureReason(
        'caption_year_mismatch',
        false,
      ),
    ).toBe('transient');
  });

  it('requires both the rollout flag and a dedicated terminal reason', () => {
    const enabled = {
      AI_TRANSLATION_TERMINAL_REJECT_ENABLED: 'true',
    } as Env;

    const disabled = {
      AI_TRANSLATION_TERMINAL_REJECT_ENABLED: 'false',
    } as Env;

    const ai = aiWithTerminalReason(
      'caption_unsupported_exact_figure',
    );

    expect(
      getTerminalTranslationRejectReason(enabled, ai),
    ).toBe('caption_unsupported_exact_figure');

    expect(
      getTerminalTranslationRejectReason(disabled, ai),
    ).toBeNull();

    expect(
      getTerminalTranslationRejectReason(
        enabled,
        aiWithTerminalReason(),
      ),
    ).toBeNull();

    expect(
      getTerminalTranslationRejectReason(
        enabled,
        {
          ...aiWithTerminalReason(),
          riskFlags: [
            'translation_terminal:caption_unsupported_exact_figure',
          ],
        },
      ),
    ).toBeNull();
  });
});
