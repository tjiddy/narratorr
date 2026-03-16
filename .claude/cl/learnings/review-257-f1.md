---
scope: [backend]
files: [apps/narratorr/src/server/config.ts]
issue: 257
source: review
date: 2026-03-05
---
Zod `.default()` only applies when the value is `undefined`, not when it's an empty string `''`. Using `.min(1).default(...)` means empty-string env vars fail validation instead of falling back. The fix is `.default(...).transform(v => v || default)` to coalesce empty strings. Would have been caught by testing with `process.env.X = ''` — the test gap allowed the regression.
