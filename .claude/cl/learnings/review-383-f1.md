---
scope: [backend, infra]
files: [.gitea/workflows/docker.yaml]
issue: 383
source: review
date: 2026-03-15
---
Reviewer caught that Dockerfile string assertions (`docker/s6-service.test.ts`) don't prove the built container actually runs Node 22 — only that the Dockerfile text contains the pin. The runtime `node --version` check must happen inside the built container. Added `docker exec` + grep to the release smoke test. Lesson: when pinning versions in infrastructure, assert the runtime output, not just the config string.
