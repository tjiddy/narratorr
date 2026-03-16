---
scope: [scope/backend, scope/services]
files: [src/server/jobs/search.ts]
issue: 357
source: spec-review
date: 2026-03-13
---
Spec review caught that the test plan described `runSearchJob` error handling as "fatal" (rethrows non-duplicate grab errors, stops the job) when the actual code has a nested try-catch: the inner catch rethrows, but the outer catch at line 168 catches it, logs a warning, and continues. The `/elaborate` subagent read the inner try-catch but missed the outer one, leading to an incorrect behavioral claim in the test plan that conflicted with AC5 (no behavioral changes).

Root cause: The subagent's source analysis identified the inner rethrow but didn't trace it to the enclosing catch block. Nested try-catch error propagation needs to be traced all the way to the outermost handler, not just the first catch.
