---
scope: [type/chore, scope/infra]
files: []
issue: 329
source: spec-review
date: 2026-03-11
---
The vulnerability table was written from a point-in-time `pnpm audit` but never dated or refreshed before spec review. For audit-driven issues, always include the snapshot date and re-run `pnpm audit` at spec review time to catch drift. The fix was adding a dated "Audit Snapshot" section with current output and per-advisory disposition classification.
