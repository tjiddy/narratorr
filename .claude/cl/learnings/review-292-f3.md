---
scope: [backend, infra]
files: [docker/s6-service.test.ts, docker-compose.yml]
issue: 292
source: review
date: 2026-03-10
---
When docker-compose.yml is part of the deliverable (referenced in AC), it needs direct regression test coverage — not just "it didn't change." The compose file defines a user-facing contract (ports, volumes, env vars) and should have tests that read it and assert the expected structure, just like we test Dockerfile content.
