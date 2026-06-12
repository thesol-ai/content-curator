import { describe, expect, it, vi } from 'vitest';
import { getRuntimeConfig } from '../apps/worker-api/src/services/runtime-config';
import type { Env } from '../apps/worker-api/src/types';

function envWithDb(db: any, overrides: Partial<Env> = {}): Env {
  return {
    APIFY_CURATION_ENABLED: 'true',
    APIFY_CURATION_DRY_RUN: 'false',
    TELEGRAM_FINAL_PUBLISH_ENABLED: 'true',
    TELEGRAM_PUBLISH_SCHEDULER_ENABLED: 'true',
    DB: db,
    ...overrides,
  } as unknown as Env;
}

function settingsDb(settings: Record<string, string>): any {
  return {
    prepare: vi.fn(() => ({
      all: vi.fn(async () => ({
        results: Object.entries(settings).map(([key, value]) => ({ key, value })),
      })),
    })),
  };
}

describe('runtime config fail-closed regression safety net', () => {
  it('does not enable live behavior when settings cannot be loaded', async () => {
    const brokenDb = {
      prepare: vi.fn(() => ({
        all: vi.fn(async () => {
          throw new Error('settings table unavailable');
        }),
      })),
    };

    await expect(getRuntimeConfig(envWithDb(brokenDb))).resolves.toMatchObject({
      curationEnabled: false,
      telegramPublishEnabled: false,
      telegramSchedulerEnabled: false,
    });
  });

  it('does not let DB settings override disabled env hard switches', async () => {
    const db = settingsDb({
      apify_curation_enabled: 'true',
      telegram_publish_enabled: 'true',
      apify_curation_dry_run: 'false',
    });

    await expect(getRuntimeConfig(envWithDb(db, {
      APIFY_CURATION_ENABLED: 'false',
      TELEGRAM_FINAL_PUBLISH_ENABLED: 'false',
    }))).resolves.toMatchObject({
      curationEnabled: false,
      telegramPublishEnabled: false,
      telegramSchedulerEnabled: false,
    });
  });

  it('keeps dry-run enabled when either env or DB requests it', async () => {
    await expect(getRuntimeConfig(envWithDb(settingsDb({
      apify_curation_enabled: 'true',
      apify_curation_dry_run: 'true',
      telegram_publish_enabled: 'true',
    })))).resolves.toMatchObject({
      curationDryRun: true,
    });

    await expect(getRuntimeConfig(envWithDb(settingsDb({
      apify_curation_enabled: 'true',
      apify_curation_dry_run: 'false',
      telegram_publish_enabled: 'true',
    }), {
      APIFY_CURATION_DRY_RUN: 'true',
    }))).resolves.toMatchObject({
      curationDryRun: true,
    });
  });
});
