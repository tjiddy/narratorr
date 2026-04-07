---
scope: [backend]
files: [src/server/jobs/enrichment.ts]
issue: 398
date: 2026-04-07
---
ESLint's `complexity` rule counts optional chaining (`?.`) as a branch point. A function with 7 `if` statements, 7 `&&` operators, and 3 `?.` usages hits complexity 18 — well over the 15 limit. Extract helpers or avoid `?.` in hot functions (use `const x = arr && arr[0]` instead of `arr?.[0]` to keep complexity down, or split into smaller functions).
