---
scope: [backend, services]
files: [src/server/services/import-queue-worker.ts]
issue: 637
source: review
date: 2026-04-18
---
Worker failure paths must persist the same state the success path persists. The success path closed phaseHistory entries and wrote them to DB, but the catch block called markJobFailed without passing phaseHistory — losing the checklist state on reload for failed jobs. Always check that failure branches mirror success-path state persistence.
