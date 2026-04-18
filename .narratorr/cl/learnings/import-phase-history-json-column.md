---
scope: [backend, db, services]
files: [src/db/schema.ts, src/server/services/import-queue-worker.ts]
issue: 637
date: 2026-04-18
---
When a UI needs to reconstruct timeline state after page reload (phase checklist), a single `phase` column is insufficient — persist a JSON array of transition entries (`{ phase, startedAt, completedAt? }`) alongside the current phase. The setPhase helper must manage both atomically: close the previous entry and append a new one in the same DB update.
