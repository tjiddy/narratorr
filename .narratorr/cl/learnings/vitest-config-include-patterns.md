---
scope: [backend, frontend]
files: [apps/narratorr/vitest.config.ts]
issue: 294
date: 2026-03-06
---
Vitest `include` patterns are explicit — tests in directories not covered by the patterns silently don't run. The narratorr vitest config only had `src/server/` and `src/client/` patterns, so `src/shared/` tests (21 existing tests in settings.test.ts) were never executing. Always check include patterns when adding test files in new directories.
