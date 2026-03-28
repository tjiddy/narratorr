---
skill: respond-to-spec-review
issue: 358
round: 1
date: 2026-03-13
fixed_findings: [F1, F2]
---

### F1: Event-history query-key invalidation behavior change
**What was caught:** Replacing `['eventHistory']` with `queryKeys.eventHistory.all()` (which returns `['eventHistory', undefined]`) would narrow TanStack Query's prefix-matching invalidation, leaving filtered event-history queries stale.
**Why I missed it:** `/elaborate` treated query key centralization as a mechanical find-and-replace without checking how TanStack Query's `invalidateQueries` actually matches query keys. The distinction between prefix keys and exact keys wasn't considered.
**Prompt fix:** Add to `/elaborate` step 3 (deep source analysis): "For query key changes used in `invalidateQueries`, verify TanStack Query prefix-matching semantics — a shorter key `['x']` invalidates all keys starting with `['x', ...]`, but `['x', undefined]` only matches that exact key. Invalidation replacements must preserve the same match breadth."

### F2: Incomplete caller/test blast radius enumeration
**What was caught:** The test plan listed 7 test files but missed `api-contracts.test.ts` and `DownloadClientCard.test.tsx`, which also reference renamed methods through module-level imports.
**Why I missed it:** `/elaborate`'s codebase exploration grepped for `api.methodName` (barrel export callers) but not `moduleApi.methodName` (direct module import callers). The contract test file calls through `authApi.getStatus()` etc., which wouldn't match the barrel pattern.
**Prompt fix:** Add to `/elaborate` step 3 (explore codebase): "For rename refactors, search for BOTH barrel-export references (`api.oldName`) and module-level references (`moduleApi.oldName`). Phrase blast radius in AC as 'exhaustive grep sweep' rather than closed lists of files."
