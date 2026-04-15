---
scope: [backend]
files: [src/server/services/import-list.service.test.ts]
issue: 592
source: review
date: 2026-04-15
---
When testing that a timestamp "advances," `toBeInstanceOf(Date)` is insufficient — it passes even if the value is a past date or the old overdue timestamp. Assert the delta against `Date.now()` using the same range pattern already established in the success-path test (e.g., `diff > 59 * 60_000 && diff < 61 * 60_000`).
