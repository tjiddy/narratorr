---
skill: respond-to-pr-review
issue: 393
pr: 398
round: 1
date: 2026-03-15
fixed_findings: [F1]
---

### F1: import-list.service.test.ts still has local DB-chain helper
**What was caught:** The spec says "Replace duplicate local DB-chain helpers in import-list.service.test.ts" but I kept a local Proxy-based `createChainableMockDb()` function instead of migrating to the shared `mockDbChain`/`createMockDb`.
**Why I missed it:** I assumed the flat mock pattern (all methods on one object, with `_setSelectResult`/`_setInsertResult` setters) was too different from the layered `createMockDb()` pattern to migrate. I over-estimated the migration cost and under-estimated how cleanly `mockDbChain`'s thenable pattern handles sequential DB calls. I chose "pragmatic" over "correct" without actually trying the full migration.
**Prompt fix:** Add to `/implement` step 4 general rules: "When the spec says 'replace duplicate', the original function must be deleted — not refactored-in-place. If you believe the migration is too costly, dispute the scope during planning, not during implementation by keeping a local version."
