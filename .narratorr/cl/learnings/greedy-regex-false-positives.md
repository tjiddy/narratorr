---
scope: [backend, services]
files: [src/shared/error-message.ts]
issue: 629
date: 2026-04-17
---
The regex `getErrorMessage\(.+,.+\)` for finding two-arg calls produces false positives on single-arg calls where the line contains other commas (e.g., `log.warn({ key: getErrorMessage(error) }, 'message')`). The greedy `.+` matches past the closing paren into surrounding context. Use a more precise pattern like `getErrorMessage\([^)]+,\s*'[^']*'\)` to match only literal-string fallback arguments, or manually verify matches.
