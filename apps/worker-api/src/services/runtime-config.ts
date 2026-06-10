// ══════════════════════════════════════════════════════════════
// services/runtime-config.ts
// Centralized effective runtime switches.
//
// Safety rule: destructive/live actions must fail closed. In practice:
// - Telegram publish requires BOTH env hard-switch and DB setting to be true.
// - Curation requires BOTH env hard-switch and DB setting to be true, unless an
//   explicit internal trigger opts into forceCurationEnabled for that request.
// - Dry-run is conservative: if either env or DB says dry-run, dry-run wins.
// ══════════════════════════════════════════════════════════════

import type { Env } from '../types';

export interface RuntimeConfig {
  maintenanceMode: boolean;
  curationEnabled: boolean;
  curationDryRun: boolean;
  telegramPublishEnabled: boolean;
  telegramSchedulerEnabled: boolean;
  settings: Record<string, string>;
}

export interface RuntimeConfigOverrides {
  forceCurationEnabled?: boolean;
  curationDryRun?: boolean;
}

const TRUE = 'true';

export async function getRuntimeConfig(
  env: Env,
  overrides: RuntimeConfigOverrides = {}
): Promise<RuntimeConfig> {
  const settings = await loadSettings(env);

  const settingCurationEnabled = settings.apify_curation_enabled === TRUE;
  const settingDryRun = settings.apify_curation_dry_run === TRUE;
  const settingTelegramPublish = settings.telegram_publish_enabled === TRUE;

  const curationEnabled = overrides.forceCurationEnabled === true
    ? true
    : env.APIFY_CURATION_ENABLED === TRUE && settingCurationEnabled;

  const curationDryRun = typeof overrides.curationDryRun === 'boolean'
    ? overrides.curationDryRun
    : env.APIFY_CURATION_DRY_RUN === TRUE || settingDryRun;

  const telegramPublishEnabled = env.TELEGRAM_FINAL_PUBLISH_ENABLED === TRUE && settingTelegramPublish;

  return {
    maintenanceMode: settings.maintenance_mode === TRUE,
    curationEnabled,
    curationDryRun,
    telegramPublishEnabled,
    telegramSchedulerEnabled: env.TELEGRAM_PUBLISH_SCHEDULER_ENABLED === TRUE && telegramPublishEnabled,
    settings,
  };
}

export function withEffectiveCurationEnv(env: Env, runtime: RuntimeConfig): Env {
  const effective = Object.create(env) as Env;
  (effective as any).APIFY_CURATION_ENABLED = runtime.curationEnabled ? TRUE : 'false';
  (effective as any).APIFY_CURATION_DRY_RUN = runtime.curationDryRun ? TRUE : 'false';
  return effective;
}

async function loadSettings(env: Env): Promise<Record<string, string>> {
  const settings: Record<string, string> = {};
  try {
    const rows = await env.DB
      .prepare('SELECT key, value FROM settings')
      .all<{ key: string; value: string }>();
    for (const row of rows.results ?? []) {
      if (typeof row.key === 'string') settings[row.key] = String(row.value ?? '');
    }
  } catch {
    // Missing DB binding/table should never enable live behavior. Return empty settings.
  }
  return settings;
}
