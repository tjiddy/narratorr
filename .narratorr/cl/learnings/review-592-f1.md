---
scope: [backend]
files: [src/server/services/merge.service.test.ts]
issue: 592
source: review
date: 2026-04-15
---
Testing error isolation (e.g., "failure on one item doesn't block others") requires asserting a success-side effect for the overall operation, not just that the next step was attempted. For merge cleanup, asserting `rm(stagingDir)` and `log.error not called` proves the merge completed successfully despite the unlink failure.
