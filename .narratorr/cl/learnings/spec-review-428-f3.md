---
scope: [scope/infra]
files: []
issue: 428
source: spec-review
date: 2026-03-17
---
Spec listed Dockerfile and CI workflows in touch points but missed `docker/s6-service.test.ts`, which hardcodes `node:22-alpine` and `'nodejs~=22'` assertions. When writing touch points for infrastructure changes, grep for the old version string across the entire repo to find all assertion/test files that reference it — not just the production files.
