---
scope: [scope/backend, scope/api]
files: [src/server/plugins/auth.ts, src/server/routes/system.ts]
issue: 279
source: spec-review
date: 2026-03-10
---
Spec proposed expanding `/api/system/status` response with sensitive system info (OS, DB size, library path) without noting it's a public route in BASE_PUBLIC_ROUTES. Always check the auth allowlist when expanding existing route responses — a route that was safe to be public with minimal data may need auth when enriched.
