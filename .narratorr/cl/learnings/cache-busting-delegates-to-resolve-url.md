---
scope: [frontend]
files: [src/client/lib/url-utils.ts]
issue: 418
date: 2026-04-08
---
When adding a specialized URL resolver (`resolveCoverUrl`), delegate to the existing `resolveUrl` for URL_BASE handling rather than duplicating the logic. This keeps DRY and means any future URL_BASE changes propagate automatically. The external-URL check must use the original `url` parameter (before `resolveUrl` transforms it) since `resolveUrl` returns the external URL unchanged — checking the resolved value works but checking the input is clearer.
