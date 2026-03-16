---
scope: [scope/backend, scope/infra]
files: [README.md, docker-compose.yml]
issue: 292
source: spec-review
date: 2026-03-10
---
Spec scoped backwards compatibility to docker-compose.yml but missed the README Docker quick-start section that encodes the same contract. When a feature changes user-facing infrastructure, check all documentation surfaces (README, examples, comments) that describe the same workflow — they all need to be in scope.
