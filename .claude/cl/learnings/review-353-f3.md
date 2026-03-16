---
scope: [infra]
files: [scripts/verify.ts, scripts/lib.ts]
issue: 353
source: review
date: 2026-03-15
---
When using `run()` to execute ESLint with `--format json`, always check `ok` before treating stdout as valid JSON. ESLint can fail (config errors, missing binary) and produce no JSON output — treating empty stdout as `[]` (no violations) silently passes the lint gate instead of falling back to full lint. The fix is to check if stdout starts with `[` when `ok` is false.
