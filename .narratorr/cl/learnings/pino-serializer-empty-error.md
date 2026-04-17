---
scope: [backend]
files: [src/server/utils/import-steps.ts, src/server/services/import.service.ts]
issue: 614
date: 2026-04-16
---
`log.error({ error }, 'Import failed')` with `error: unknown` serializes to `"error":{}` in Pino output — the default serializer doesn't unwrap arbitrary `unknown` values. Diagnosing the actual failure required wrapping the catch to log `error.message`/`error.stack` explicitly. When an error log lands with `{}`, add a temporary `errorMessage: error instanceof Error ? error.message : String(error)` alongside. Long-term fix: a shared `serializeError` helper used at every `catch (error: unknown)` site that logs.
