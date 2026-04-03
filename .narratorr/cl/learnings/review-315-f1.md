---
scope: [backend, services]
files: [src/server/routes/index.ts, src/server/routes/index.test.ts]
issue: 315
source: review
date: 2026-04-03
---
Reviewer caught that the new `blacklistService` DI wiring in `createServices()` was untested. Because `blacklistCancelledRelease()` silently returns when the dependency is missing, a dropped or reordered constructor arg would make the feature no-op in production without any test failure. The self-review and coverage review both missed this because they focused on the orchestrator unit tests, not the service-graph wiring layer. Lesson: when adding a new optional dependency to a constructor, always test the wiring in the composition root — not just the consumer.
