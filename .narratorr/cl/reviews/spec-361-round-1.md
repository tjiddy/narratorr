---
skill: respond-to-spec-review
issue: 361
round: 1
date: 2026-03-15
fixed_findings: [F1, F2, F3, F4]
---

### F1: AC permits private methods but file can't pass 400-line lint rule that way
**What was caught:** AC1 allowed "private methods or extracted utility functions" but the file is 614 lines with a 400-line max-lines rule — private methods don't reduce file length.
**Why I missed it:** `/elaborate` didn't cross-reference the refactoring strategy against the ESLint threshold. It identified that the eslint-disable existed but didn't do the math: 614 lines - inlined private methods = still 614 lines.
**Prompt fix:** Add to `/elaborate` step 3 deep source analysis: "For refactoring issues that involve removing eslint-disable overrides, check `eslint.config.js` for the actual threshold and verify the proposed extraction strategy produces a file below that threshold. Private methods don't reduce file line count."

### F2: Wrong production caller surface
**What was caught:** AC4 named `jobs/import.ts` as a caller but the production scheduler calls through `jobs/index.ts`. `jobs/import.ts` is only consumed by its test.
**Why I missed it:** The explore subagent grepped for `ImportService` and found `jobs/import.ts` without tracing whether it's a production entry point or just a test helper.
**Prompt fix:** Add to `/elaborate` step 3 explore prompt: "When identifying callers for public API stability guarantees, trace the full call chain to production entry points (route handlers, job schedulers). Distinguish between production consumers and test-only references."

### F3: Misclassified awaited steps as fire-and-forget
**What was caught:** The AC lumped awaited-but-nonfatal steps (old path cleanup, tag embedding) with truly fire-and-forget work (notifier, event history). Tests assert ordering between the awaited steps.
**Why I missed it:** Both patterns "continue on failure" but have different semantics: `await fn().catch()` is ordered, `fn().catch()` is detached. The elaborate step saw "catches error and continues" and treated them as equivalent.
**Prompt fix:** Add to `/elaborate` step 3 deep source analysis bullet list: "Distinguish between `await fn().catch()` (awaited, ordered, nonfatal) and `fn().catch()` (detached fire-and-forget). Check whether tests assert ordering between the steps — if so, they're not fire-and-forget."

### F4: Claimed existing test coverage was missing
**What was caught:** Scope boundaries said disk-space/tag-embedding/post-processing were "previously uncovered" but they already had tests.
**Why I missed it:** Relied on a stale debt.md note from #350 instead of reading the current test file to verify coverage.
**Prompt fix:** Add to `/elaborate` step 3 explore prompt: "When claiming test coverage gaps, always verify by reading the current test file rather than relying on debt.md or workflow-log notes which may be outdated by subsequent work."
