---
scope: [backend, services]
files: [src/server/services/quality-gate.helpers.ts]
issue: 62
date: 2026-03-24
---
Multi-narrator comparison should use subset/overlap semantics (any token from download appears in existing set), NOT exact set equality. Upload sites routinely omit narrators; requiring all narrators to match both ways would hold legitimate downloads where the tag lists fewer narrators than the book. The correct implementation: `new Set(existingTokens)` + `downloadTokens.some(n => existingSet.has(n))`. This handles both the single-tag-vs-multi-book case (existing test at line ~188) and the multi-tag-vs-multi-book case.
