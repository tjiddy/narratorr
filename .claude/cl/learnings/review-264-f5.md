---
scope: [scope/core]
files: [src/core/indexers/myanonamouse.ts, src/core/indexers/errors.ts]
issue: 264
source: review
date: 2026-03-08
---
Reviewer caught that auth failures used generic `Error` instead of typed errors as required by AC9. Downstream code had to match on error message strings instead of error type.

**Root cause:** Spec gap — AC9 said "typed errors" but implementation used string messages. Should have checked if a typed error class existed or created one before implementing.

**Prevention:** When a spec mentions "typed errors", create/use a dedicated error class before writing throw statements. Check existing error patterns in the codebase (e.g., `src/core/metadata/errors.ts` had `RateLimitError` as a model).
