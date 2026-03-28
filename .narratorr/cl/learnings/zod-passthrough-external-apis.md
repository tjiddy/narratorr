---
scope: [core]
files: [packages/core/src/download-clients/schemas.ts, packages/core/src/prowlarr/schemas.ts]
issue: 257
date: 2026-03-05
---
When adding Zod schemas for external API responses, always use `.passthrough()` on object schemas. Without it, Zod strips unknown keys, which breaks when upstream APIs add new fields. Also use `.default()` on non-critical numeric fields (like qBittorrent's `total_size`, `downloaded`, etc.) — partial responses from the API or mock fixtures will fail validation otherwise.
