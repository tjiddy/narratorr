---
scope: [backend, services]
files: [src/server/services/enrichment-utils.ts]
issue: 79
date: 2026-03-24
---
Audio tag narrator fields often contain multiple names delimited by comma, semicolon, or ampersand. Use `s.split(/[,;&]/).map(n => n.trim()).filter(n => n.length > 0)` before writing to the narrator junction table. This pattern matches `quality-gate.helpers.ts` line 50. `bookService.update({ narrators: string[] })` accepts the plain string array directly.
