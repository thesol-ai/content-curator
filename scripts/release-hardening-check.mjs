import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.cwd();
const strict = process.env.RELEASE_STRICT === '1' || process.argv.includes('--strict');
const errors = [];
const warnings = [];

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function exists(path) {
  return existsSync(join(root, path));
}

function warn(message) {
  warnings.push(message);
}

function fail(message) {
  errors.push(message);
}

function parseTomlVarsSection(toml, header) {
  const lines = toml.split(/\r?\n/);
  const values = {};
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inSection = trimmed === header;
      continue;
    }
    if (!inSection || !trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Z0-9_]+)\s*=\s*"([^"]*)"/);
    if (m) values[m[1]] = m[2];
  }
  return values;
}

function walkFiles(dir, acc = []) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return acc;
  for (const entry of readdirSync(abs)) {
    const p = join(abs, entry);
    const rel = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (['node_modules', '.git', 'dist', '.wrangler'].includes(entry)) continue;
      walkFiles(rel, acc);
    } else {
      acc.push(rel);
    }
  }
  return acc;
}

const requiredFiles = [
  'README.md',
  'RELEASE_CHECKLIST.md',
  'RELEASE_NOTES_NEXT.md',
  'MEDIA_QA.md',
  'DEPENDENCY_AUDIT.md',
  'wrangler.toml',
  'apps/worker-api/src/services/runtime-config.ts',
  'apps/worker-api/src/services/telegram-message-formatter.ts',
  'apps/worker-api/src/services/telegram-publisher.ts',
  'apps/worker-api/src/routes/admin.ts',
];

for (const file of requiredFiles) {
  if (!exists(file)) fail(`Missing required release file: ${file}`);
}

const expectedMigrations = [
  '0001_core.sql',
  '0002_seed_categories.sql',
  '0003_branding_finance.sql',
  '0004_media_processing.sql',
  '0005_thumbnail_urls.sql',
  '0006_media_observability.sql',
  '0007_apify_extraction_diagnostics.sql',
  '0008_ai_usage.sql',
  '0009_message_format_controls.sql',
  '0010_editorial_controls.sql',
  '0011_content_filter_controls.sql',
  '0012_apify_source_task_binding.sql',
];

const migrationDir = join(root, 'migrations');
const migrations = existsSync(migrationDir)
  ? readdirSync(migrationDir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()
  : [];

for (const migration of expectedMigrations) {
  if (!migrations.includes(migration)) fail(`Missing expected migration: ${migration}`);
}

const numbers = migrations.map((f) => Number(f.slice(0, 4))).filter(Number.isFinite);
for (let i = 1; i <= numbers.length; i += 1) {
  if (!numbers.includes(i)) fail(`Migration numbering gap: missing ${String(i).padStart(4, '0')}`);
}

if (new Set(numbers).size !== numbers.length) fail('Duplicate migration number detected.');

const pkg = JSON.parse(read('package.json'));
for (const script of ['typecheck', 'test', 'build', 'validate', 'validate:media', 'validate:release', 'validate:audit']) {
  if (!pkg.scripts?.[script]) fail(`Missing npm script: ${script}`);
}


const audit = spawnSync('npm', ['audit', '--audit-level=moderate', '--json'], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

if (audit.error) {
  warn(`npm audit could not be executed: ${audit.error.message}`);
} else {
  const auditText = audit.stdout || audit.stderr || '';
  try {
    const auditJson = JSON.parse(auditText || '{}');
    const total = Number(auditJson.metadata?.vulnerabilities?.total ?? 0);
    if (total > 0 || audit.status !== 0) {
      fail(`npm audit reports ${total} vulnerabilities at audit-level=moderate.`);
    }
  } catch {
    if (audit.status !== 0) fail('npm audit failed and did not return parseable JSON.');
  }
}

if (exists('wrangler.toml')) {
  const wrangler = read('wrangler.toml');
  const baseVars = parseTomlVarsSection(wrangler, '[vars]');
  const prodVars = parseTomlVarsSection(wrangler, '[env.production.vars]');

  if (baseVars.TELEGRAM_FINAL_PUBLISH_ENABLED !== 'false') fail('Default TELEGRAM_FINAL_PUBLISH_ENABLED must remain false.');
  if (baseVars.TELEGRAM_PUBLISH_SCHEDULER_ENABLED !== 'false') fail('Default TELEGRAM_PUBLISH_SCHEDULER_ENABLED must remain false.');
  if (baseVars.APIFY_CURATION_ENABLED !== 'false') fail('Default APIFY_CURATION_ENABLED must remain false.');
  if (baseVars.APIFY_CURATION_DRY_RUN !== 'true') fail('Default APIFY_CURATION_DRY_RUN must remain true.');
  if (baseVars.STREAM_TRANSCODE_ENABLED !== 'false') fail('Default STREAM_TRANSCODE_ENABLED must remain false.');

  const riskyProductionFlags = [
    ['APIFY_CURATION_ENABLED', 'true'],
    ['APIFY_CURATION_DRY_RUN', 'false'],
    ['TELEGRAM_FINAL_PUBLISH_ENABLED', 'true'],
    ['TELEGRAM_PUBLISH_SCHEDULER_ENABLED', 'true'],
  ];

  for (const [key, riskyValue] of riskyProductionFlags) {
    if (prodVars[key] === riskyValue) {
      const message = `Production ${key} is ${riskyValue}; confirm this is intentional before deploy.`;
      if (strict) fail(message);
      else warn(message);
    }
  }

  if (Number(prodVars.TELEGRAM_PUBLISH_DUE_LIMIT ?? 0) > 5) {
    const message = `Production TELEGRAM_PUBLISH_DUE_LIMIT is ${prodVars.TELEGRAM_PUBLISH_DUE_LIMIT}; consider 5 or lower for pilot rollout.`;
    if (strict) fail(message);
    else warn(message);
  }
}

if (exists('apps/worker-api/src/services/runtime-config.ts')) {
  const runtimeConfig = read('apps/worker-api/src/services/runtime-config.ts');
  if (!runtimeConfig.includes('telegramPublishEnabled') || !runtimeConfig.includes('telegramSchedulerEnabled')) {
    fail('runtime-config.ts must expose telegram publish and scheduler effective config.');
  }
  if (!runtimeConfig.includes('env.TELEGRAM_FINAL_PUBLISH_ENABLED === TRUE && settingTelegramPublish')) {
    fail('runtime-config.ts must require env and DB setting for Telegram publish.');
  }
  if (!runtimeConfig.includes('env.TELEGRAM_PUBLISH_SCHEDULER_ENABLED === TRUE && telegramPublishEnabled')) {
    fail('runtime-config.ts must make scheduler depend on effective Telegram publish.');
  }
}

if (exists('apps/worker-api/src/services/telegram-publisher.ts')) {
  const publisher = read('apps/worker-api/src/services/telegram-publisher.ts');
  if (publisher.includes('link_preview_options: { is_disabled: false }')) {
    fail('telegram-publisher.ts still enables Telegram link previews.');
  }
  if (!publisher.includes('link_preview_options: { is_disabled: true }')) {
    fail('telegram-publisher.ts must disable link previews for sendMessage paths.');
  }
  if (!publisher.includes('prepareTelegramCaptions')) {
    fail('telegram-publisher.ts should expose shared caption preparation for preview/publish consistency.');
  }
}

if (exists('apps/worker-api/src/services/ai-gate.ts')) {
  const aiGate = read('apps/worker-api/src/services/ai-gate.ts');
  if (/include source URL at the end/i.test(aiGate)) {
    fail('ai-gate prompt still asks model to include source URL in captions.');
  }
  if (!/Do NOT include source URLs|Do not include source URLs/i.test(aiGate)) {
    fail('ai-gate prompt should explicitly forbid raw source URLs in captions.');
  }
}

if (exists('apps/worker-api/src/routes/admin.ts')) {
  const admin = read('apps/worker-api/src/routes/admin.ts');
  for (const routeNeedle of ['/internal/publish/due', '/internal/queue/', '/preview']) {
    if (!admin.includes(routeNeedle)) warn(`admin.ts may be missing route marker: ${routeNeedle}`);
  }
}

const highRiskFiles = [
  ...walkFiles('apps'),
  ...walkFiles('tests'),
  ...walkFiles('scripts'),
  'README.md',
  'RELEASE_CHECKLIST.md',
  'RELEASE_NOTES_NEXT.md',
  'MEDIA_QA.md',
  'DEPENDENCY_AUDIT.md',
  '.env.example',
  'wrangler.toml',
].filter((f) => exists(f));

const secretNames = [
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'APIFY_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'INTERNAL_API_SECRET',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_STREAM_API_TOKEN',
];

const allowedSecretPatterns = [
  /process\.env\.[A-Z0-9_]+/,
  /env\.[A-Z0-9_]+/,
  /wrangler secret put/,
  /x-internal-api-secret/i,
  /SECRET/,
  /your-/i,
  /placeholder/i,
  /123:test-token/,
  /test-token/,
  /test-secret/,
  /anthropic-test/,
  /gemini-test/,
  /configured-token/,
  /dummy/i,
  /mock/i,
];

for (const file of highRiskFiles) {
  const text = read(file);
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const name of secretNames) {
      if (!line.includes(name)) continue;
      const hasAssignment = new RegExp(`${name}\\s*[=:]\\s*["'][^"']{12,}["']`).test(line);
      const isAllowed = allowedSecretPatterns.some((pattern) => pattern.test(line));
      if (hasAssignment && !isAllowed) fail(`Possible committed secret in ${file}:${index + 1}`);
    }
  });
}

if (errors.length > 0) {
  console.error('[release-hardening-check] failed');
  for (const error of errors) console.error(`- ${error}`);
  if (warnings.length > 0) {
    console.error('\nWarnings:');
    for (const warning of warnings) console.error(`- ${warning}`);
  }
  process.exit(1);
}

console.log('[release-hardening-check] passed');
console.log(`Checked ${migrations.length} migrations, ${highRiskFiles.length} files, and release docs.`);
if (warnings.length > 0) {
  console.log('\nWarnings requiring release-owner review:');
  for (const warning of warnings) console.log(`- ${warning}`);
  console.log('\nRun RELEASE_STRICT=1 npm run validate:release to fail on these warnings.');
}
