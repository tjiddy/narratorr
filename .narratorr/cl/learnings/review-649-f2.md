---
scope: [backend, services]
files: [src/server/utils/import-steps.ts, src/server/utils/import-steps.test.ts]
issue: 649
source: review
date: 2026-04-18
---
When simplifying a helper function's contract (removing a conditional bypass), the helper needs direct tests even if it previously had none. The spec noted "no verifyCopy tests exist — add regression coverage if signature simplified" but we didn't follow through during implementation. Always check the spec's test-plan items against what was actually written before handoff.
