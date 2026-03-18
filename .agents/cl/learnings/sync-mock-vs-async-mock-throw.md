---
scope: [backend]
files: [apps/narratorr/src/server/routes/metadata.test.ts]
issue: 246
date: 2026-02-24
---
When a service method is synchronous (like `getProviders()`) but its test uses `mockRejectedValue`, the method returns a rejected Promise instead of throwing synchronously. This bypasses the try/catch in the route handler and hits Fastify's default error handler, which returns "Internal Server Error" (capital S) instead of the route's custom "Internal server error" (lowercase s). Fix: use `mockImplementation(() => { throw new Error(...) })` for synchronous methods.
