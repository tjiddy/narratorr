---
scope: [scope/backend, scope/infra]
files: [Dockerfile, docker/entrypoint.sh]
issue: 292
source: spec-review
date: 2026-03-10
---
Current State said "raw node CMD" when the Dockerfile actually uses an entrypoint script. When describing the current startup path, check the actual ENTRYPOINT/CMD in the Dockerfile rather than assuming. The distinction matters because replacing an entrypoint is a different operation than adding one.
