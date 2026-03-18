---
scope: [backend]
files: [src/server/routes/health-routes.ts, src/server/routes/health.test.ts]
issue: 365
date: 2026-03-15
---
When testing that a route uses a dynamic function (like `getVersion()`) instead of a hardcoded value, and the hardcoded value happens to match the real value, you can't distinguish them with a simple assertion. Mock the module with `vi.mock()` to return a clearly distinct value (e.g., `'99.88.77'`), then assert against that. The mock must be at file scope since the route module captures imports at load time.
