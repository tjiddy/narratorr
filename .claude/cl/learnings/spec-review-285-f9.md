---
scope: [scope/backend, scope/services]
files: [src/server/jobs/index.ts]
issue: 285
source: spec-review
date: 2026-03-11
---
Round 1 fix defined the single-poller pattern (query DB for due rows) but didn't specify the poller's own wake-up cadence. The reviewer caught that "timeout-loop with per-row scheduling" is underspecified without stating how often the loop fires. Fix: when specifying a polling job, always define both the polling cadence (how often the job wakes) and the per-entity scheduling (how each row determines its next run).
