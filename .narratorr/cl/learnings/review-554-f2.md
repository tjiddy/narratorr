---
scope: [backend]
files: [src/server/services/import.service.ts]
issue: 554
source: review
date: 2026-04-14
---
When moving a side-effect call outside a transaction to achieve isolation, the call must also be isolated from the outer error handler. If the outer catch runs cleanup (file removal, status revert), a throw from the post-commit call undoes the committed work. Always wrap post-commit best-effort calls in their own try/catch.
