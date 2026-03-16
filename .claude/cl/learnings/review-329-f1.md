---
scope: [infra]
files: [package.json, pnpm-lock.yaml]
issue: 329
source: review
date: 2026-03-11
---
The lockfile had a phantom `apps/narratorr` workspace importer from a previous workspace config. This caused `pnpm audit` to report old versions of direct deps we'd already upgraded. The fix was deleting the lockfile + node_modules and doing a clean `pnpm install`. Additionally, runtime transitive vulnerabilities (minimatch, ajv, file-type) can be patched via `pnpm.overrides` without waiting for upstream parent packages. Should have run `pnpm audit` post-install and investigated the `apps\narratorr` paths immediately — they were a red flag that something was wrong with the lockfile.
