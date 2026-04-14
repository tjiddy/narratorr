---
scope: [backend]
files: [src/server/routes/search.ts, src/server/routes/search.test.ts]
issue: 545
source: review
date: 2026-04-14
---
Route-layer log behavior changes need route-level test coverage, even when the helper is already tested. The test helper's `logger: false` made this seem impossible, but creating a one-off Fastify instance with `logger: { level: 'debug', stream: writableStream }` captures pino output for assertion. The gap was assuming helper-level coverage was sufficient — the reviewer correctly flagged that a regression in the route wiring (e.g., removing the `sanitizeLogUrl` call) would pass silently.
