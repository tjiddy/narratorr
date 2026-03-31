---
scope: [backend, services]
files: [src/server/services/library-scan.service.test.ts, src/server/services/discovery.service.test.ts]
issue: 246
source: review
date: 2026-03-31
---
When the spec explicitly requires caller-level tests for shared behavior changes, those tests must be written during implementation — not deferred. The handoff coverage review should have caught this but the self-review and coverage subagent both noted it as "adjacent" instead of "required."
