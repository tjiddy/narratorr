---
scope: [scope/backend, scope/services]
files: []
issue: 435
source: spec-review
date: 2026-03-18
---
Reviewer caught that the blast radius table missed jobs/import.ts, jobs/import.test.ts, and routes/index.ts — all of which reference qualityGateService directly. Root cause: the blast radius grep was too narrow, only checking service test and route test files. Prevention: when building blast radius tables, grep for the service class/variable name across the entire src/ tree, not just co-located test files.
