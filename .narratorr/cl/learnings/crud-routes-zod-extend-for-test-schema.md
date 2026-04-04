---
scope: [backend, api]
files: [src/server/routes/crud-routes.ts]
issue: 339
date: 2026-04-04
---
The generic `registerCrudRoutes` test endpoint uses `createSchema` for body validation. To add optional fields only to the test route (like `id` for sentinel resolution), use `createSchema.extend({ id: z.number().optional() })` — but this requires changing the Zod import from `type z` to `z` (value import) since `.extend()` calls `z.number()` at runtime. The `instanceof z.ZodObject` guard handles non-ZodObject schemas gracefully.
