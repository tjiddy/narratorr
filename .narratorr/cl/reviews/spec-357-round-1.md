---
skill: respond-to-spec-review
issue: 357
round: 1
date: 2026-03-13
fixed_findings: [F1, F2, F3]
---

### F1: `runSearchJob` error semantics misstated as fatal
**What was caught:** Test plan described `runSearchJob` as rethrowing non-duplicate grab errors (fatal to the job), but the actual code has nested try-catch where the outer catch logs a warning and continues.
**Why I missed it:** The `/elaborate` subagent's source analysis read the inner try-catch but didn't trace the rethrown error to the enclosing outer catch block. Nested error propagation wasn't followed to completion.
**Prompt fix:** Add to `/elaborate` step 10 (deep source analysis): "For try-catch blocks that rethrow: trace the rethrown error to its next handler. Nested try-catch patterns require following the error all the way to the outermost catch to determine effective behavior (catch-and-continue vs propagate)."

### F2: `triggerImmediateSearch` omitted from deduplication scope
**What was caught:** `routes/books.ts` contains a 4th copy of the search-and-grab loop (`triggerImmediateSearch`) that the spec didn't include in its scope.
**Why I missed it:** The elaboration validated the files and functions named in the existing spec findings but didn't independently scan for additional instances of the duplicated pattern.
**Prompt fix:** Add to `/elaborate` step 3 (Explore subagent prompt): "For deduplication/refactoring issues: independently grep for ALL instances of the duplicated code pattern across the codebase. Do not rely solely on the instances named in the issue spec — the spec may have missed copies."

### F3: Missing blast radius table for refactoring issue
**What was caught:** No structured listing of affected test files and mock sites for a multi-file code move.
**Why I missed it:** The elaboration skill's gap-fill step categorizes durable content as AC, test plan, and scope boundaries — but doesn't include blast radius as a category for refactoring issues.
**Prompt fix:** Add to `/elaborate` step 4 (fill gaps): "For `type/chore` or refactoring issues that move code between files: add a Blast Radius section listing affected test files, mock sites (`vi.mock` paths), and import paths that will change."
