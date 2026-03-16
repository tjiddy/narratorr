---
scope: [scope/backend, scope/api]
files: [src/server/routes/system.ts]
issue: 280
source: review
date: 2026-03-10
---
The download route had both 200 (file stream) and 404 (backup not found) branches but tests only covered the happy path. Prevention: file-serving routes must test both the success stream and the not-found case.
