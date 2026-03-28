---
scope: [backend]
files: [src/server/routes/import-lists.ts]
issue: 188
source: review
date: 2026-03-28
---
The annotation sweep only changed `catch (error)` → `catch (error: unknown)` but didn't audit whether the catch body accessed `error` via a bare cast. `(error as Error).message` is a runtime crash on non-Error throws even after the binding annotation is correct. The fix: always use `getErrorMessage(error)` instead of `.message` direct access. The self-review step should grep changed catch blocks for `(error as Error)` or `(error as any)` patterns after an annotation sweep.
