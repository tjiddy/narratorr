---
scope: [backend]
files: [apps/narratorr/src/server/routes/auth.test.ts]
issue: 168
date: 2026-02-23
---
Auth route tests need a custom `createAuthTestApp()` instead of the shared `createTestApp()` because auth routes require `@fastify/cookie` (for `reply.setCookie`/`reply.clearCookie`) and a `request.user` decoration (for protected routes like password change). Without the cookie plugin, login/logout returns 500. Without user decoration, protected routes return 401.
