---
scope: [scope/infra]
files: []
issue: 428
source: spec-review
date: 2026-03-17
---
`@types/node updated to Node 24-compatible version` was too vague to be a pass/fail AC. Should have specified the expected major version range (`^24.x`) and where it needs to appear (package.json + lockfile). Version-bump ACs should always state the concrete target range, not just "compatible."
