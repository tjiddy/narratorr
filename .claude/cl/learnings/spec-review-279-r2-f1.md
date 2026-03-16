---
scope: [scope/backend]
files: [src/server/jobs/index.ts, src/server/jobs/version-check.ts]
issue: 279
source: spec-review
date: 2026-03-10
---
Spec referenced version-check job and status.update? field that only exist in open PR #335, not on main. When writing specs, verify referenced artifacts exist on main — not just on the current working branch. Specs should declare explicit dependencies on unmerged work or conditionally handle either merge order.
