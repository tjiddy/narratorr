---
scope: [scope/services]
files: [src/server/services/backup.service.ts, src/server/services/backup.service.test.ts]
issue: 280
source: review
date: 2026-03-10
---
The highest-risk method (create: mutex, VACUUM INTO, zip, cleanup) had no tests. Tests covered list/prune/validate/confirm but skipped create because it required complex mocking (archiver, createWriteStream, libSQL). Root cause: complex-to-mock methods got skipped in favor of easier-to-test methods. Prevention: start with the riskiest method first, even if it requires more mock setup.
