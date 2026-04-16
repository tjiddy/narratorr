---
scope: [infra, testing]
files: [e2e/playwright.config.ts]
issue: 612
date: 2026-04-16
---
Playwright's default `outputDir` and HTML `reporter.outputFolder` are resolved relative to the process cwd (where `playwright test` was invoked), NOT the config file's directory. Running `pnpm test:e2e` from repo root dumps `test-results/` at the repo root even when the config lives at `e2e/playwright.config.ts`. Fix: compute an absolute path via `fileURLToPath(import.meta.url)` + `dirname` in the config, then pass it to `outputDir` and any reporter `outputFolder`. Same pattern applies to any path in a Playwright config that should be anchored to the config file.
