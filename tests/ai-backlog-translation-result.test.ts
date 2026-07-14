import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  isRetryableTranslationResult,
} from '../apps/worker-api/src/services/ai-backlog-translation-stage';

import type {
  AIGateResult,
} from '../apps/worker-api/src/types';

function makeResult(
  overrides:
    Partial<AIGateResult> = {},
): AIGateResult {
  return {
    publish: true,
    score: 90,
    riskLevel: 'low',
    riskFlags: [],
    topicFingerprint: 'topic',
    publishPriority: 'normal',
    translations: {
      fa: {
        title: 'title',
        caption: 'caption',
      },
    },
    ...overrides,
  } as AIGateResult;
}

describe(
  'staged translation validation',
  () => {
    it(
      'retries empty translations',
      () => {
        expect(
          isRetryableTranslationResult(
            makeResult({
              translations: {},
              riskFlags: [
                'translation_missing',
              ],
            }),
          ),
        ).toBe(true);
      },
    );

    it(
      'retries missing target flags',
      () => {
        expect(
          isRetryableTranslationResult(
            makeResult({
              riskFlags: [
                'translation_missing:fa',
              ],
            }),
          ),
        ).toBe(true);
      },
    );

    it(
      'does not retry terminal failures',
      () => {
        expect(
          isRetryableTranslationResult(
            makeResult({
              translations: {},
              riskFlags: [
                'translation_missing',
              ],
              translationTerminalReason:
                'caption_factual_failure',
            }),
          ),
        ).toBe(false);
      },
    );

    it(
      'accepts complete translations',
      () => {
        expect(
          isRetryableTranslationResult(
            makeResult(),
          ),
        ).toBe(false);
      },
    );
  },
);
