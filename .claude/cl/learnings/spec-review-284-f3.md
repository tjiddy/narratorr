---
scope: [scope/frontend]
files: [src/client/hooks/useAuth.ts]
issue: 284
source: spec-review
date: 2026-03-09
---
Missed `window.location.href = '/login'` in useAuth.ts logout flow — bypasses React Router basename and breaks subpath deployments. When speccing URL_BASE or subpath features, always grep for `window.location` assignments across client code — they're invisible to React Router's basename handling.
