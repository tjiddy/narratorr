---
scope: [backend, api]
files: [src/server/routes/prowlarr.ts]
issue: 315
source: review
date: 2026-03-11
---
Prowlarr config routes were missed during masking integration because they're a standalone route file, not part of the CRUD route pattern. When adding cross-cutting concerns like response masking, enumerate ALL route files that handle secret-bearing entities — not just the ones using shared helpers. The /plan step should have grepped for all routes returning secret fields.
