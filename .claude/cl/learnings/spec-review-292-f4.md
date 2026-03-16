---
scope: [scope/backend, scope/infra]
files: [Dockerfile]
issue: 292
source: spec-review
date: 2026-03-10
---
Used `~10s` as a startup time AC — not objectively measurable. Timing ACs need a concrete measurement method (e.g., "healthcheck passes within N seconds of docker compose up") and a defined environment context, or they should be dropped entirely.
