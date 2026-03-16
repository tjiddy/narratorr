---
scope: [scope/backend, scope/services]
files: []
issue: 355
source: spec-review
date: 2026-03-13
---
When adding server-side defaults (limit, pagination) to existing list routes, always check what frontend consumers do with the full dataset. Client-side filtering, counting, and aggregation break silently when the backend starts truncating. The spec must define a transition strategy (explicit large limit, opt-in pagination, or bring UI pagination into scope).
