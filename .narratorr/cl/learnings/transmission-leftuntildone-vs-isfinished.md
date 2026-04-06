---
scope: [core]
files: [src/core/download-clients/transmission.ts]
issue: 373
date: 2026-04-06
---
Transmission's `isFinished` field means "seeding stopped due to ratio/idle limit," NOT "download complete." Use `leftUntilDone === 0` as the authoritative completion signal. The numeric `status` field alone is also unreliable — `status=0` (stopped) can mean paused OR completed depending on `leftUntilDone`. The combination of `leftUntilDone` + `status` gives the correct state.
