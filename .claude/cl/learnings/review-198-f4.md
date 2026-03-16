---
scope: [backend]
files: [src/server/services/import.service.test.ts]
issue: 198
source: review
date: 2026-03-12
---
Reviewer caught that import pipeline ordering wasn't tested — the script hook could move before tag embedding or after markImported without failing any test. Fixed by recording call order with mock implementations. Pattern: when a feature's AC specifies "runs after X and before Y," always add an ordering test that tracks call sequence.
