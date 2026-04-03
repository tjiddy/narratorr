---
scope: [frontend]
files: [src/client/hooks/useEventSource.ts]
issue: 309
date: 2026-04-03
---
When adding conditional logic (like a cache-miss fallback) to an already-complex function, check ESLint cyclomatic complexity BEFORE committing. The `handleEvent` callback was at complexity 15 (the limit) — adding one `if (!found)` branch pushed it to 16. Extracting the patch logic into a standalone function upfront would have avoided a second commit cycle.
