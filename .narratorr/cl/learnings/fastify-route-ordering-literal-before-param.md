---
scope: [backend, api]
files: [src/server/routes/activity.ts]
issue: 54
date: 2026-03-21
---
Fastify matches routes by registration order, not specificity. `DELETE /api/activity/history` (literal) must be registered BEFORE `DELETE /api/activity/:id/history` (parameterized) — otherwise Fastify matches "history" as the `:id` param and the bulk-clear route is unreachable. Always register more-specific (literal) paths before parameterized siblings.
