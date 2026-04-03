---
scope: [backend, frontend]
files: [src/server/services/backup.service.ts, src/client/pages/settings/SystemSettings.tsx]
issue: 324
date: 2026-04-03
---
Changing a service from throwing to returning error results (e.g., `{ valid: false, error }` instead of `throw new RestoreUploadError`) requires updating the route handler, the client mutation callbacks (`onSuccess` must now handle error results), AND existing tests that assert `.rejects.toThrow()`. The route code itself may need no changes if it already returns the service result directly — the 200 status code is implicit from Fastify's return-value response.
