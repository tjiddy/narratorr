---
scope: [scope/backend, scope/infra]
files: [Dockerfile, docker/entrypoint.sh]
issue: 292
source: spec-review
date: 2026-03-10
---
Spec described the LSIO service user model incorrectly — said "starts Node.js as the PUID/PGID user" when LSIO actually uses a pre-created `abc` user that gets its UID/GID remapped at init time. When adopting an external framework's conventions, verify the actual runtime model from their docs rather than projecting the current implementation's mental model onto it. Also: when replacing infrastructure (entrypoint → s6-overlay), the spec must explicitly call out what gets removed, not just what gets added.
