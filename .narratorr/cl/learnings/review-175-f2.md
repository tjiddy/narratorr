---
scope: [scope/infra]
files: [package.json, docker-compose.yml]
issue: 175
source: review
date: 2026-03-10
---
Changed docker:build to tag as ghcr.io/todd/narratorr:local while docker:up still used compose which now references :latest. The two scripts became incoherent — building locally then running "up" would ignore the local build. Reviewer suggestion F5 warned about this behavior change but we over-corrected. When compose changes from build to image, the simplest fix for local scripts is to leave them alone — they serve a different workflow.
