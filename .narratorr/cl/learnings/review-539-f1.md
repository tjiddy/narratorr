---
scope: [backend]
files: [src/server/services/import.service.ts, src/server/services/import-orchestrator.ts]
issue: 539
source: review
date: 2026-04-13
---
When a CAS-style method returns a boolean and a new guard path also returns `false`, the caller's retry loop can't distinguish "normal miss" from "unexpected failure." The loop retried the same row forever because `getNextQueuedDownload` always returns the oldest queued row. Fix: throw on unexpected conditions so the loop halts. Lesson: when adding a new failure mode to a method consumed by a retry loop, verify whether the caller distinguishes that failure from normal retryable cases.
