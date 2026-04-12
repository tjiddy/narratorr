---
scope: [frontend]
files: [src/client/hooks/useSettingsForm.test.ts]
issue: 485
source: review
date: 2026-04-12
---
When a shared hook centralizes a query path for multiple consumers, the error/rejection path needs explicit test coverage — not just the "pending" or "undefined" boundary case. The hook test had a "never resolves" boundary test but no "rejects" test, leaving the error isolation behavior for all 10 migrated sections uncovered.
