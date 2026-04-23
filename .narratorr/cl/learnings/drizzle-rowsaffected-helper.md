---
scope: [backend]
files: [src/server/utils/db-helpers.ts, src/server/services/import-queue-worker.ts, src/server/services/discovery.service.ts]
issue: 678
date: 2026-04-23
---
Drizzle's libSQL driver exposes `rowsAffected` on update/delete results but its public types omit the field, so callers reached through `as unknown as { rowsAffected?: number }` at each site. Centralized the access in `getRowsAffected(result: unknown): number`, which throws on missing/non-numeric values rather than silently returning `undefined`. Throwing is the right default because a missing field would be a driver/version regression — and in the CAS-claim path (`drainOne()`), silent `0` would reintroduce the infinite re-claim bug captured in `review-635-f2.md`. When rerouting a new error source into an existing `try/catch`, audit the catch's `log.warn`/`log.error` call for raw-`unknown` logging — CLAUDE.md and the `narratorr/no-raw-error-logging` ESLint rule require `serializeError()` wrapping, otherwise Pino serializes the caught value to `{}`.
