---
scope: [scope/backend, scope/infra]
files: []
issue: 292
source: spec-review
date: 2026-03-10
---
Spec described the in-container target path for s6 service files but not the repo source path. When adding new artifacts to a build, name both the source-controlled path (e.g., `docker/root/`) and the container target path so implementers know the expected repo structure.
