# Technical Debt

## crud-routes.ts: getAll handler missing `await`
- **File:** `apps/narratorr/src/server/routes/crud-routes.ts:32`
- **Issue:** `return service.getAll()` should be `return await service.getAll()` — without `await`, the try/catch is dead code and rejections bypass the handler's error logging/formatting, falling through to Fastify's default error handler instead.
- **Impact:** Error response format differs from all other CRUD endpoints (Fastify format vs handler's `{ error: 'Internal server error' }`). No error logging occurs for getAll failures.
- **Fix:** Add `await` keyword. One-line change.
- **Found:** #157 (2026-02-21)
