---
scope: [backend]
files: [src/server/routes/auth.ts]
issue: 17
date: 2026-03-20
---
`config.authBypass` is `undefined` (not `false`) when the `AUTH_BYPASS` env var is not set. Assigning it directly to a response field causes JSON serialization to omit the field entirely (JSON drops `undefined` values). Always coerce with `Boolean(config.authBypass)` when the field must appear in the JSON response. Without this, the frontend receives no field at all instead of `false`.
