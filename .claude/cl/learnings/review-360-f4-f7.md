---
scope: [backend, services]
files: [src/server/jobs/monitor.ts, src/server/services/download.service.ts, src/server/services/quality-gate.service.ts, src/server/services/import.service.ts]
issue: 360
source: review
date: 2026-03-14
---
When changing `catch { }` to `catch (e) { log.debug(e, 'msg') }`, existing "does not throw" tests pass whether or not the logging actually runs. The reviewer correctly flagged that "resolves.not.toThrow()" is a survival test, not an observability test. For every new logging branch, add an assertion on the specific log method (log.debug) with the exact error object and message string. This proves the new code runs, not just that it doesn't crash.
