---
scope: [scope/backend, scope/infra]
files: [Dockerfile, docker/entrypoint.sh]
issue: 292
source: spec-review
date: 2026-03-10
---
Described LSIO's PUID=0 behavior as "skips remap" when it actually remaps abc to uid/gid 0. When specifying behavior of external frameworks, verify against their actual source code rather than inferring from common patterns. The LSIO init-adduser script treats PUID=0 as a valid remap target, not a skip condition.
