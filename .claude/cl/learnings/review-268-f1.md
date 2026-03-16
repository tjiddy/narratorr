---
scope: [scope/backend]
files: [src/server/routes/activity.test.ts]
issue: 268
source: review
date: 2026-03-09
---
Approve endpoint test asserted the HTTP response but not that the fire-and-forget import trigger was actually called, nor did it test the failure/catch path. When a route has side effects beyond the response (fire-and-forget calls), tests must assert those side effects are invoked and that failures in them don't break the response. Pattern: any `.catch()` branch in route code needs its own test exercising the rejection path.
