---
scope: [backend]
files: [src/server/services/import-orchestrator.ts]
issue: 539
date: 2026-04-13
---
When an in-memory resource (semaphore slot) gates a DB state transition (CAS claim), acquiring the resource *before* the DB write eliminates the need for a revert path entirely. The original claim→check-slot→revert pattern created a visibility window and error-recovery complexity that slot-first admission avoids by design. This pattern applies wherever an in-memory gate precedes a persistent state change.
