---
scope: [infra]
files: [e2e/global-setup.ts, e2e/global-setup.test.ts]
issue: 616
source: review
date: 2026-04-17
---
Every new infrastructure mechanism (file write, file read, file cleanup) needs its own test — even when the mechanism is "just plumbing" for the real feature. The `.run-paths.json` handoff had three behaviors (write, read-from-worker, cleanup) that were all unproven after the F1 fix. The minimum: one test per behavior, with the worker-simulation test explicitly clearing `process.env.E2E_SOURCE_PATH` to prove the file-based fallback path.
