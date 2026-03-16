---
scope: [scope/backend, scope/infra]
files: [docker/entrypoint.sh, docker/entrypoint.test.ts]
issue: 292
source: spec-review
date: 2026-03-10
---
Spec asserted PUID=0 "should work" in edge cases while the current implementation explicitly rejects it. When migrating to a new framework (LSIO), edge case behavior must be evaluated against the target framework's model, not just stated optimistically. The LSIO init actually supports PUID=0 (skips remap), so the behavior change is intentional but needed to be promoted from edge case to AC.
