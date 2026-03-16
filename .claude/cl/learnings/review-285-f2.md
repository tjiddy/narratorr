---
scope: [backend, api]
files: [src/shared/schemas/import-list.ts, src/server/routes/import-lists.ts]
issue: 285
source: review
date: 2026-03-11
---
Form-level validation schemas (with superRefine) were not reused at the API layer. The create endpoint used a basic schema without provider-specific field validation, allowing invalid configs through. When validation logic exists in a form schema, verify the corresponding server route uses the same validation — or better, define validation once and share it.
