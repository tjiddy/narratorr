---
scope: [core]
files: [src/core/download-clients/schemas.ts, src/core/download-clients/nzbget.ts]
issue: 270
date: 2026-04-01
---
NZBGet JSON-RPC errors are objects `{ name, code, message }`, not strings. The Zod schema had `z.string()` which caused `[object Object]` in error messages via string coercion. When modeling external API error shapes, always verify against official docs — string vs object is a common mismatch that passes simple tests but breaks real error reporting.
