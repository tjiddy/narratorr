---
scope: [backend]
files: [src/server/routes/system.test.ts, src/server/routes/system.ts]
issue: 333
source: review
date: 2026-03-10
---
Reviewer caught that status route tests stubbed `getUpdateStatus()` return values but never asserted the call arguments. The route could ignore settings and always call `getUpdateStatus('')` and tests would pass. Lesson: when a route reads from one source (settings) and passes data to another function (getUpdateStatus), assert BOTH the return value AND the call arguments to prove the data flows correctly.
