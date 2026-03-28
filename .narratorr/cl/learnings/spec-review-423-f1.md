---
scope: [scope/backend, scope/frontend]
files: []
issue: 423
source: spec-review
date: 2026-03-17
---
Reviewer caught that AC1/AC2 only covered the SPA fallback injection path, missing direct static entry routes (`/<urlBase>/`, `/<urlBase>/index.html`) served by `@fastify/static` which bypass the not-found handler entirely. The spec assumed all HTML responses went through the same injection path without verifying the actual request flow. A runtime probe showed these routes returning raw `index.html`. Would have been caught by tracing all code paths that serve `index.html` during spec writing, not just the obvious SPA fallback.