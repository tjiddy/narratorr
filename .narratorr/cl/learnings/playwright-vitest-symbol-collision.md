---
scope: [infra]
files: [e2e/playwright.config.ts]
issue: 614
date: 2026-04-16
---
Playwright's default `testMatch` includes `*.test.ts` (not just `*.spec.ts`). If the testDir hierarchy contains vitest files (our `e2e/fakes/*.test.ts`, `e2e/fixtures/*.test.ts`), Playwright will try to load them, and the `@vitest/expect` module collides with `@playwright/test`'s expect on `Symbol($$jest-matchers-object)` — you get hundreds of "Cannot redefine property" errors. Fix: set `testMatch: /.*\.spec\.ts/` in the Playwright config so only `.spec.ts` files qualify. Don't rename vitest helper tests to `.spec.ts` — they ARE vitest, not Playwright.
