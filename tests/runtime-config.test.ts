import { describe, expect, it, vi } from 'vitest';
import { getRuntimeConfig } from '../apps/worker-api/src/services/runtime-config';
import type { Env } from '../apps/worker-api/src/types';

function env(settings: Record<string, string>, overrides: Partial<Env> = {}): Env {
  return {
    APIFY_CURATION_ENABLED: 'true',
    APIFY_CURATION_DRY_RUN: 'false',
    TELEGRAM_FINAL_PUBLISH_ENABLED: 'true',
    TELEGRAM_PUBLISH_SCHEDULER_ENABLED: 'true',
    DB: {
      prepare: vi.fn(() => ({
        all: vi.fn(async () => ({
          results: Object.entries(settings).map(([key, value]) => ({ key, value })),
        })),
      })),
    },
    ...overrides,
  } as unknown as Env;
}

describe('runtime config safety switches', () => {
  it('requires both Telegram env hard-switch and DB setting to enable publishing', async () => {
    await expect(getRuntimeConfig(env({ telegram_publish_enabled: 'true' })))
      .resolves.toMatchObject({ telegramPublishEnabled: true });

    await expect(getRuntimeConfig(env({ telegram_publish_enabled: 'true' }, { TELEGRAM_FINAL_PUBLISH_ENABLED: 'false' })))
      .resolves.toMatchObject({ telegramPublishEnabled: false });

    await expect(getRuntimeConfig(env({ telegram_publish_enabled: 'false' })))
      .resolves.toMatchObject({ telegramPublishEnabled: false });
  });

  it('requires both curation env hard-switch and DB setting unless forced by an internal trigger', async () => {
    await expect(getRuntimeConfig(env({ apify_curation_enabled: 'true' })))
      .resolves.toMatchObject({ curationEnabled: true });

    await expect(getRuntimeConfig(env({ apify_curation_enabled: 'true' }, { APIFY_CURATION_ENABLED: 'false' })))
      .resolves.toMatchObject({ curationEnabled: false });

    await expect(getRuntimeConfig(
      env({ apify_curation_enabled: 'false' }, { APIFY_CURATION_ENABLED: 'false' }),
      { forceCurationEnabled: true },
    )).resolves.toMatchObject({ curationEnabled: true });
  });

  it('keeps curation in dry-run if either env or DB setting requests dry-run', async () => {
    await expect(getRuntimeConfig(env({ apify_curation_dry_run: 'true' })))
      .resolves.toMatchObject({ curationDryRun: true });

    await expect(getRuntimeConfig(env({ apify_curation_dry_run: 'false' }, { APIFY_CURATION_DRY_RUN: 'true' })))
      .resolves.toMatchObject({ curationDryRun: true });

    await expect(getRuntimeConfig(env({ apify_curation_dry_run: 'false' })))
      .resolves.toMatchObject({ curationDryRun: false });
  });

  it('requires scheduler env flag and effective publish permission for scheduled publishing', async () => {
    await expect(getRuntimeConfig(env({ telegram_publish_enabled: 'true' })))
      .resolves.toMatchObject({ telegramSchedulerEnabled: true });

    await expect(getRuntimeConfig(env({ telegram_publish_enabled: 'true' }, { TELEGRAM_PUBLISH_SCHEDULER_ENABLED: 'false' })))
      .resolves.toMatchObject({ telegramSchedulerEnabled: false });

    await expect(getRuntimeConfig(env({ telegram_publish_enabled: 'true' }, { TELEGRAM_FINAL_PUBLISH_ENABLED: 'false' })))
      .resolves.toMatchObject({ telegramPublishEnabled: false, telegramSchedulerEnabled: false });

    await expect(getRuntimeConfig(env({ telegram_publish_enabled: 'false' })))
      .resolves.toMatchObject({ telegramPublishEnabled: false, telegramSchedulerEnabled: false });
  });

});
