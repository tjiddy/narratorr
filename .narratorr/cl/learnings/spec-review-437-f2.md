---
scope: [scope/backend]
files: [src/server/routes/settings.ts, src/server/routes/books.ts, src/server/routes/search.ts]
issue: 437
source: spec-review
date: 2026-03-18
---
Reviewer caught that the route-import cleanup AC ("no remaining direct imports from src/core/ in any route file") was broader than the problem statement (which only named settings.ts). Other routes also import from src/core/ for utility constants/helpers, making the grep-based test plan impossible to satisfy. Root cause: AC was written as an aspirational grep check without verifying which route files actually import from src/core/. Prevention: when writing greppable AC, always run the grep first and enumerate the actual matches to confirm the AC is achievable within scope.
