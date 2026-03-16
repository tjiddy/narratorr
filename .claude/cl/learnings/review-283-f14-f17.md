---
scope: [backend]
files: [src/server/services/download.service.ts, src/server/services/quality-gate.service.ts]
issue: 283
source: review
date: 2026-03-10
---
When adding SSE emissions to service methods, every method that triggers a status change needs its own emission test — not just the "main" flow methods. grab(), cancel(), approve(), and reject() all had emissions added in the implementation but no dedicated tests. The pattern: if a method has a `broadcaster?.emit()` call, it needs (1) a test asserting the exact event type and payload, and (2) a throw-resilience test proving the method doesn't break if emit throws. Checklist: grep for `broadcaster?.emit` in each service file and verify 1:1 test coverage.
