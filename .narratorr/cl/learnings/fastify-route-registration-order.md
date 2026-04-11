---
scope: [backend]
files: []
date: 2026-04-10
---
Fastify matches routes by registration order, not specificity. `GET /api/items/history` (literal) must be registered BEFORE `GET /api/items/:id` (parameterized) — otherwise Fastify matches "history" as the `:id` param and the literal route is unreachable. Always register more-specific literal paths before parameterized siblings.
