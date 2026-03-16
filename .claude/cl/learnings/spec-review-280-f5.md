---
scope: [scope/backend, scope/services]
files: [src/server/jobs/index.ts, src/server/jobs/search.ts, src/server/jobs/rss.ts]
issue: 280
source: spec-review
date: 2026-03-10
---
Spec said "stop all jobs → replace DB file → restart" without verifying that jobs have no stop handles. `startJobs()` returns void, and all schedulers use fire-and-forget setTimeout/cron with no cancellation API. The elaboration step identified this as a hazard but didn't force the spec to define the actual execution model. Any spec that assumes runtime control (stopping jobs, draining connections, maintenance mode) must verify the control surface exists and define the approach if it doesn't.
