---
scope: [scope/backend, scope/api, scope/frontend]
files: [src/server/routes/crud-routes.ts]
issue: 285
source: spec-review
date: 2026-03-11
---
Round 1 promoted preview to AC as `POST /:id/preview` (requires saved row), but the UI test plan said "preview before committing config" (unsaved data). The route contract and UX flow contradicted each other. Fix: when adding a preview/test endpoint, explicitly decide whether it operates on saved data (requires :id) or unsaved data (accepts config in body), and align AC, route, and frontend tests to the same flow.
