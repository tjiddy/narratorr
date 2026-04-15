---
scope: [frontend]
files: [src/client/lib/manual-chunks.ts, src/client/lib/manual-chunks.test.ts]
issue: 584
source: review
date: 2026-04-15
---
Substring `.includes()` matchers for scoped npm packages must use a trailing `/` to bound the match to the exact package. Without it, `@tanstack/react-query` also matches `@tanstack/react-query-devtools`. The existing `react/` matcher already had this pattern (line 4), but we didn't apply it consistently to the new TanStack rules. The test for "unrelated @tanstack packages" used `react-table` which wouldn't false-match anyway — a devtools-specific boundary test was needed.
