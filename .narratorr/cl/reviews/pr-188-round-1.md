---
skill: respond-to-pr-review
issue: 188
pr: 190
round: 1
date: 2026-03-28
fixed_findings: [F1, F2, F3]
---

### F1: import-lists.ts bare (error as Error).message cast
**What was caught:** `(error as Error).message` in the ABS libraries catch block crashes on non-Error throws after the annotation sweep changed the binding to `unknown`.
**Why I missed it:** The annotation sweep focused on the catch _binding_ only (`catch (error)` → `catch (error: unknown)`), not on the catch _body_. The self-review step checked representative files but didn't specifically grep for `(error as Error)` patterns introduced by the sweep.
**Prompt fix:** Add to `/handoff` self-review step 1 (behavior correctness check): "For annotation sweep PRs, grep `(error as Error)` and `(error as any)` across all changed catch blocks. Any hit in a catch body is a potential crash on non-Error throws — replace with `getErrorMessage(error)` or an `instanceof` guard."

### F2: import-list.service.ts bare cast in log arguments
**What was caught:** Same cast pattern as F1, in two log call arguments. Logging expressions are structurally identical to response-building code but are visually less prominent.
**Why I missed it:** Coverage review focused on return-value behaviors, not log statement arguments. Both instances were in `log.warn` calls inside catch bodies where the fix was less obvious than in response objects.
**Prompt fix:** Add to `/handoff` self-review step 1: "Check structured log call arguments inside catch blocks — `{ error: (error as Error).message }` in a log call is the same crash risk as in a response payload."

### F3: audio-processor.ts structural cast without object guard
**What was caught:** `(error as { stderr?: string }).stderr` accessed without the same null/object guard pattern used in the search.ts fix.
**Why I missed it:** The `message` line above it was already guarded (`instanceof Error`), which gave a false sense that the block was safe. The `stderr` access was a separate structural cast that required its own guard.
**Prompt fix:** Add to `/plan` step 3 (codebase exploration): "After an annotation sweep, grep for `(error as {` to find structural property access on `unknown` catch variables. Each hit needs an `error !== null && typeof error === 'object' && 'prop' in error` guard before the cast."
