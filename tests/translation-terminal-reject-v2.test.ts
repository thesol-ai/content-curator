import {
  describe,
  expect,
  it,
} from 'vitest';

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
    riskFlags: [
      'translation_missing',
    ],
    topicFingerprint:
      'bitcoin-etf-flow',
    publishPriority:
      'normal',
    translations: {},
    translationTerminalReason:
      reason ?? null,
  };
}

describe(
  'terminal caption rejection',
  () => {
    it('keeps legacy numeric reasons transient', () => {
      expect(
        classifyTranslationFailureReason(
          'caption_unsupported_exact_figure',
          true,
        ),
      ).toBe('transient');

      expect(
        classifyTranslationFailureReason(
          'caption_unsupported_number:42',
          true,
        ),
      ).toBe('transient');
    });

    it('keeps missing attribution terminal only after repair', () => {
      expect(
        classifyTranslationFailureReason(
          'caption_missing_required_attribution',
          false,
        ),
      ).toBe('transient');

      expect(
        classifyTranslationFailureReason(
          'caption_missing_required_attribution',
          true,
        ),
      ).toBe('terminal');
    });

    it('keeps structural, stylistic, and year failures retryable', () => {
      for (
        const reason
        of [
          'translation_invalid_json',
          'rtl_repair_failed',
          'caption_title_mismatch',
          'caption_quality_low',
          'caption_year_mismatch',
        ]
      ) {
        expect(
          classifyTranslationFailureReason(
            reason,
            true,
          ),
        ).toBe('transient');
      }
    });

    it('requires both the rollout flag and a terminal reason', () => {
      const enabled = {
        AI_TRANSLATION_TERMINAL_REJECT_ENABLED:
          'true',
      } as Env;

      const disabled = {
        AI_TRANSLATION_TERMINAL_REJECT_ENABLED:
          'false',
      } as Env;

      const ai =
        aiWithTerminalReason(
          'caption_missing_required_attribution',
        );

      expect(
        getTerminalTranslationRejectReason(
          enabled,
          ai,
        ),
      ).toBe(
        'caption_missing_required_attribution',
      );

      expect(
        getTerminalTranslationRejectReason(
          disabled,
          ai,
        ),
      ).toBeNull();

      expect(
        getTerminalTranslationRejectReason(
          enabled,
          aiWithTerminalReason(),
        ),
      ).toBeNull();
    });
  },
);
