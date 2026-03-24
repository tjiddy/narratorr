---
scope: [infra]
files: [vitest.config.ts, scripts/lib.test.ts]
issue: 323
date: 2026-03-09
---
Tests in `scripts/` weren't discovered until `'scripts/**/*.test.ts'` was added to `vitest.config.ts` include array. Any new test directory outside `src/` needs an explicit include pattern.
