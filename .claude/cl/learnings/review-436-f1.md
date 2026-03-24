---
scope: [backend, services]
files: [src/server/jobs/index.ts, src/server/jobs/index.test.ts]
issue: 436
source: review
date: 2026-03-17
---
When rewiring a task-registry callback (e.g., changing which service the `import` job calls), the existing tests only checked registration and scheduling — not callback execution. The reviewer caught that the test suite would pass even if the callback still called the old service. Fix: add a test that calls `taskRegistry.executeTracked('import')` and asserts the correct services are called in order. Lesson: any time a registered callback changes targets, add an execution-level assertion, not just a registration-level one.
