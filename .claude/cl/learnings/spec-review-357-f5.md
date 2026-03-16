---
scope: [scope/backend, scope/services]
files: [src/server/routes/books.ts]
issue: 357
source: spec-review
date: 2026-03-13
---
Spec review caught that the Findings section overstated the query-builder duplication count (7 vs actual 6) and attributed 2 occurrences to `routes/books.ts` when there is only 1. The count was inflated when expanding scope to include `triggerImmediateSearch` — the original elaboration assumed the new call site added a new query construction instance without verifying.

Root cause: When expanding scope based on a review finding (adding `triggerImmediateSearch`), the count in the Findings summary was incremented without re-grepping to verify the actual total. Counts in spec findings should be verified by grep, not adjusted arithmetically.
