# Dependency Audit Remediation

This phase updates the development toolchain to clear the npm audit findings that were present during release hardening.

## What changed

Updated direct development dependencies:

```text
vitest 2.x  -> 4.1.8+
wrangler 3.x -> 4.98.0+
```

These upgrades remove the transitive advisories reported through:

```text
@vitest/mocker
vite
vite-node
esbuild
miniflare
undici
ws
```

The project has no runtime npm production dependencies. The affected packages are development/build/test tooling, but they still matter because CI, local testing, and deploy dry-runs use them. Pretending dev tooling cannot hurt production is how projects acquire exciting folklore.

## Verification commands

Run these before merging or deploying:

```bash
npm ci
npm audit --audit-level=moderate
npm run typecheck
npm test -- --reporter=dot
npm run build
npm run validate:media
npm run validate:release
```

Expected audit result:

```text
found 0 vulnerabilities
```

## Notes

- `wrangler` was upgraded across a major version. The dry-run build was checked with the new version.
- `vitest` was upgraded across a major version. The full test suite was checked with the new version.
- No dashboard files were changed in this phase.
- No secrets are required for dependency audit validation.
