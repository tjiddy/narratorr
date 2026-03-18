# F15: Scheduler test never fired the timer

- **Issue**: #280
- **Date**: 2026-03-10
- **Scope**: scope/backend
- **Resolution**: fixed
- **Files**: src/server/jobs/backup.ts, src/server/jobs/backup.test.ts

Testing a recursive setTimeout scheduler requires advancing fake timers past the interval AND awaiting to let async callbacks resolve, then asserting the job ran and a new timer was scheduled. Just advancing timers without awaiting leaves the async callback unresolved and the test passes vacuously.
