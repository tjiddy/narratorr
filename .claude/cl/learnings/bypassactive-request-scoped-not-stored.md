---
scope: [backend]
files: [src/server/routes/auth.ts, src/server/services/auth.service.ts]
issue: 8
date: 2026-03-19
---
`bypassActive` must be computed per-request in the route handler (not stored in the service layer) because it depends on `request.ip` to evaluate the local bypass condition. The service's `getStatus()` returns `localBypass` (a stored flag), but computing `bypassActive = config.authBypass || (status.localBypass && isPrivateIp(request.ip))` requires request context unavailable in the service. Pattern: store flags, compute derived/request-scoped values at the route boundary.
