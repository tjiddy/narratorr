---
scope: [scope/infra]
files: [docker-compose.yml]
issue: 175
source: spec-review
date: 2026-03-10
---
AC referenced the existing docker-compose.yml for validating published images, but the compose file uses `build: .` (local build), not `image:` (pull from registry). The scope boundary also said compose files were out of scope while an AC depended on them. When elaborating infra issues where artifacts already exist, verify that existing files actually support the new workflow — don't assume "already shipped" means "compatible with the new use case."
