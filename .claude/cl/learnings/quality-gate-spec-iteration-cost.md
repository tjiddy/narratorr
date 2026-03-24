---
scope: [backend, services]
files: [src/server/services/quality-gate.helpers.ts, src/server/services/quality-gate.service.ts]
issue: 39
date: 2026-03-20
---
The quality gate spec went through 4 review rounds (8 findings total) before approval. The main friction was: (1) spec referenced nonexistent field names (`filePath` instead of `path`, `auto_imported` instead of `imported`), (2) null-book behavior was incorrectly described, (3) AC scope was too broad (said "without holding" but narrator_mismatch still applies), (4) the service fallback `else` branch was not identified as a required change site. Lesson: when speccing a fix that changes conditional logic in a service, explicitly enumerate ALL branches that fire for the affected case — not just the helper pushes, but the service's decision tree too.
