---
scope: [frontend]
files: [src/client/lib/error-message.ts]
issue: 486
date: 2026-04-11
---
For mechanical DRY extractions (identical pattern across many files), a general-purpose subagent handles the bulk replacement more efficiently than manual file-by-file editing. The key is giving it the exact pattern, the import path, and clear rules for variations (variable names, template literals, JSX context). Verify with a single grep after to confirm zero remaining instances.
