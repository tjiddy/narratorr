---
scope: [scope/services, scope/backend]
files: [src/server/services/library-scan.service.ts, src/server/services/library-scan.service.test.ts]
issue: 79
source: review
date: 2026-03-24
---
Reviewer caught that `buildBookCreatePayload()` dropped multi-author metadata whenever `item.authorName` was already set (common path for folder-parsed books), violating the AC to preserve provider multi-author metadata.

The original fix used `item.authorName ? [single] : meta.authors`, which made `item.authorName` an absolute override. The correct rule is: single-author metadata → defer to parsed folder author (user override); multi-author metadata (>1 entry) → preserve the full array regardless of parsed author.

What let this slip: the test suite only covered metadata-only and fallback-only paths. The interaction test (both parsed author AND multi-author metadata present) was missing. When writing "preserves user-provided values" tests, also add an "extends user-provided values" variant for the multi-author enrichment path.
