---
scope: [backend]
files: [src/server/jobs/index.test.ts]
issue: 366
date: 2026-03-16
---
Adding a new job to `jobs/index.ts` also requires updating the hardcoded job count in `jobs/index.test.ts` (line 56: `expect(tasks).toHaveLength(N)`). This is similar to the settings category count blast radius. The pattern: any test with `toHaveLength(<literal>)` on a registry/list is a blast radius target for any feature that adds to that registry.
