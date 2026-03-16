---
scope: [scope/backend, scope/services]
files: [src/server/services/book.service.ts]
issue: 372
source: review
date: 2026-03-16
---
When implementing sort with a default case (createdAt), still use the computed direction variable (`dir`) rather than hardcoding `desc()`. The default branch of a switch is just as likely to receive user-provided sort direction as any other branch. Test all sort fields with both asc and desc directions.
