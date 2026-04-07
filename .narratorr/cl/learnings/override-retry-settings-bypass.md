---
scope: [backend, services]
files: [src/server/utils/rejection-helpers.ts]
issue: 396
date: 2026-04-07
---
`overrideRetry: true` in `blacklistAndRetrySearch()` was documented as bypassing the `redownloadFailed` setting, but the implementation still called `settingsService.get('import')` first — a settings lookup failure silently suppressed retry even with the override. The fix: check `overrideRetry` BEFORE the settings read and return early on the override path. When a flag says "bypass X," verify it actually skips the code path for X, not just the boolean check after X succeeds.
