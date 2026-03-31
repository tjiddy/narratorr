---
scope: [backend]
files: [src/server/services/indexer.service.ts]
issue: 240
date: 2026-03-31
---
When migrating a sequential for-of loop to `Promise.allSettled()`, maintain index correlation between the input array and settlements array for error attribution. Use `settlements[i]` with `enabledIndexers[i]` — don't destructure the settlement value until after checking status. Also switch Pino error logging from `{ error }` to `{ err: error }` since Pino's serializer only activates on the `err` key.
