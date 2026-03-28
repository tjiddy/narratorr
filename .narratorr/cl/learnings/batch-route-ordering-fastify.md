---
scope: [scope/backend]
files: [apps/narratorr/src/server/routes/books.ts]
issue: 214
date: 2026-02-24
---
When adding `DELETE /api/books/missing` alongside `DELETE /api/books/:id`, the batch route must be registered BEFORE the parameterized route — otherwise Fastify matches `:id` = "missing" first. The extracted `registerDeleteMissingRoute` must be called before `registerDeleteBookRoute` in the wiring sequence.
