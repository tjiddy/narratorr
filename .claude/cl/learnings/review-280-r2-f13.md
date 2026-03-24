# F13: Restore upload route had no multipart success test

- **Issue**: #280
- **Date**: 2026-03-10
- **Scope**: scope/backend, scope/api
- **Resolution**: fixed
- **Files**: src/server/routes/system.ts, src/server/routes/system.test.ts

Route-level tests for multipart endpoints need a test app with @fastify/multipart registered and real zip payloads via archiver. Without this setup, the happy path for restore upload goes completely untested.
