---
scope: [infra]
files: [e2e/tests/critical-path/manual-import.spec.ts, e2e/global-setup.ts]
issue: 616
source: review
date: 2026-04-17
---
The spec used `getCurrentRun()` and `process.env.E2E_SOURCE_PATH` to obtain sourcePath in Playwright workers, but both mechanisms only work in the config process — not in worker processes. The existing `qbitControlUrl` pattern works because ports are static/known at code-write time and can use a fixed fallback. For dynamic paths (temp dirs that change every run), file-based handoff is the only worker-safe mechanism: globalSetup writes to a `.run-paths.json` state file, workers read it via the `getE2ESourcePath()` helper. The learning from the existing codebase (global-setup.ts:128 comment) was read but not properly applied.
