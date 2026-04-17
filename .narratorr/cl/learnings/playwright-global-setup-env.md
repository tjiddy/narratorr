---
scope: [infra]
files: [e2e/global-setup.ts, e2e/tests/critical-path/search-grab-import.spec.ts]
issue: 614
date: 2026-04-16
---
Playwright's `globalSetup` runs in the main config process; `process.env` mutations there do NOT propagate to test worker processes. Tests that read `process.env.FOO` after globalSetup sets it will get `undefined`. Either set env via `playwright.config.ts` `use.env`/`webServer.env` (static), or export a helper from globalSetup with a fallback default that tests import. Our fix: `qbitControlUrl(path)` helper with hardcoded default port as fallback.
