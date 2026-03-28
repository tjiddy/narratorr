---
scope: [backend, infra]
files: [Dockerfile]
issue: 292
date: 2026-03-10
---
LSIO base images use s6-overlay as PID 1 — do NOT set ENTRYPOINT or CMD in the Dockerfile. The s6 init system handles process startup via service definitions. Setting ENTRYPOINT would bypass the entire init system (user creation, chown, signal routing).
