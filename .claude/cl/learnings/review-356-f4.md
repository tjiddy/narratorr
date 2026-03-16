---
scope: [backend, services]
files: [src/server/routes/activity.test.ts]
issue: 356
source: review
date: 2026-03-15
---
When adding a new awaited service call inside a route's try/catch, the route's error path test must cover the new call rejecting — not just the original service call. Each new await is a new error vector that needs its own 500-path test.
