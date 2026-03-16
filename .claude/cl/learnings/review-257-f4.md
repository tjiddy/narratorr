---
scope: [backend]
files: [apps/narratorr/src/server/services/settings.service.ts]
issue: 257
source: review
date: 2026-03-05
---
When wrapping DB reads with `safeParse()`, distinguish between "value absent" (undefined/null = never stored) and "value malformed" (stored but invalid shape). Logging warn for absent values creates noise on every `getAll()` call when not all categories are stored. Guard with `if (raw === undefined || raw === null) return default` before attempting `safeParse`.
