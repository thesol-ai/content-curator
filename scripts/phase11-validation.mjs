import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const phaseHeadings = [
  '### Phase 0 — Baseline',
  '### Phase 1 — Configuration Consistency & No-Cost Stream Safety',
  '### Phase 2 — Scheduling Correctness',
  '### Phase 3 — Telegram Publisher Reliability',
  '### Phase 4 — R2 Stable URL Behavior',
  '### Phase 5 — Thumbnail Validation',
  '### Phase 6 — Media Status & Observability',
  '### Phase 7 — Apify Normalization Hardening',
  '### Phase 8 — Category & Channel Prompt Wiring',
  '### Phase 9 — Cloudflare Stream Fallback Hardening',
  '### Phase 10 — AI Reliability & Cost Guardrails',
  '### Phase 11 — End-to-End Validation Baseline',
];

const removedPhaseDocs = [
  'PHASE0_BASELINE.md',
  'PHASE1_SAFETY.md',
  'PHASE2_SCHEDULING.md',
  'PHASE3_TELEGRAM_PUBLISHER.md',
  'PHASE4_R2_STABLE_URLS.md',
  'PHASE5_THUMBNAIL_VALIDATION.md',
  'PHASE6_MEDIA_OBSERVABILITY.md',
  'PHASE7_APIFY_NORMALIZATION.md',
  'PHASE8_PROMPT_WIRING.md',
  'PHASE9_STREAM_FALLBACK.md',
  'PHASE10_AI_RELIABILITY.md',
  'PHASE11_E2E_VALIDATION.md',
];

const requiredMigrations = [
  '0001_core.sql',
  '0002_seed_categories.sql',
  '0003_branding_finance.sql',
  '0004_media_processing.sql',
  '0005_thumbnail_urls.sql',
  '0006_media_observability.sql',
  '0007_apify_extraction_diagnostics.sql',
  '0008_ai_usage.sql',
];

const errors = [];
const readmePath = join(root, 'README.md');
if (!existsSync(readmePath)) {
  errors.push('Missing README.md');
} else {
  const readme = readFileSync(readmePath, 'utf8');
  if (!readme.includes('## Implementation Phases & Validation History')) {
    errors.push('README.md must contain the consolidated phase history section.');
  }
  for (const heading of phaseHeadings) {
    if (!readme.includes(heading)) errors.push(`README.md missing phase heading: ${heading}`);
  }
}

for (const doc of removedPhaseDocs) {
  if (existsSync(join(root, doc))) errors.push(`Separate phase document should be removed after README consolidation: ${doc}`);
}

for (const migration of requiredMigrations) {
  if (!existsSync(join(root, 'migrations', migration))) errors.push(`Missing migration: ${migration}`);
}

const wrangler = readFileSync(join(root, 'wrangler.toml'), 'utf8');
if (!/STREAM_TRANSCODE_ENABLED\s*=\s*"false"/.test(wrangler)) {
  errors.push('STREAM_TRANSCODE_ENABLED must remain false by default.');
}
if (!/MEDIA_GROUP_PARTIAL_PUBLISH_ENABLED\s*=\s*"true"/.test(wrangler)) {
  errors.push('MEDIA_GROUP_PARTIAL_PUBLISH_ENABLED should remain explicitly true by default.');
}

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!packageJson.scripts?.validate) errors.push('Missing npm run validate script.');
if (!packageJson.scripts?.['validate:phase11']) errors.push('Missing npm run validate:phase11 script.');

if (errors.length > 0) {
  console.error('[phase11-validation] failed');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log('[phase11-validation] passed');
console.log(`Checked README consolidation for ${phaseHeadings.length} phases and ${requiredMigrations.length} migrations.`);
