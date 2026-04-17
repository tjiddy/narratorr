---
scope: [backend, infra]
files: [src/server/config.test.ts, docker/s6-service.test.ts, e2e/global-setup.test.ts]
issue: 623
source: review
date: 2026-04-17
---
Deletion PRs need negative regression assertions — not just removal of positive tests. When deleting a feature/env-var/field, add `expect(...).not.toContain()`/`not.toHaveProperty()` tests proving the deleted surface stays deleted. Without these, re-introduction would go undetected. The /plan step should flag deletion issues and generate negative-assertion stubs alongside the removal plan.
