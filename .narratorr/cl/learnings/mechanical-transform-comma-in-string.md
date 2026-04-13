---
scope: [backend]
files: [src/server/services/search-pipeline.test.ts, src/server/routes/search.test.ts]
issue: 522
date: 2026-04-13
---
When scripting mechanical argument transformations (e.g., positional → options bag), naive comma-splitting breaks on string literals containing commas (e.g., `'German, Abridged'`). The transform script must track quote depth alongside brace/bracket depth. In this issue, 5 test calls were mis-transformed because `'German, Abridged'` was split into two arguments. Always verify transformed output by running tests before committing, and spot-check lines containing comma-separated string values.
