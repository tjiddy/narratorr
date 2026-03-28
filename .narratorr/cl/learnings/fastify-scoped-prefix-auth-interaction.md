---
scope: [backend]
files: [src/server/index.ts, src/server/plugins/auth.ts]
issue: 284
date: 2026-03-09
---
Fastify scoped route registration (`app.register(fn, { prefix })`) applies the prefix to routes inside the scope, but `fp()` plugins (like auth) propagate to the parent scope. This means auth hooks see the FULL URL including prefix, while route handlers see the URL WITHOUT prefix. The auth plugin must independently construct prefixed paths for PUBLIC_ROUTES matching — it can't rely on the scoped prefix being stripped.
