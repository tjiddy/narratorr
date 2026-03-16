---
scope: [backend]
files: [src/server/server-utils.ts]
issue: 284
source: review
date: 2026-03-10
---
SPA fallback must be scoped to the URL_BASE prefix. When URL_BASE is `/narratorr`, a catch-all not-found handler that only checks for `/narratorr/api/` will serve index.html for completely unrelated paths like `/books/123`. The fix: reject requests whose path doesn't start with the URL_BASE prefix. This was missed because the initial implementation only considered the "API vs non-API" distinction, not the "in-scope vs out-of-scope" distinction.
