---
scope: [frontend]
files: [src/client/components/SearchReleasesModal.tsx, src/shared/schemas/search.ts]
issue: 412
date: 2026-04-10
---
`Object.keys(grabSchema.shape)` dynamically extracts field names from a Zod object schema at runtime. This enables a `pickGrabFields()` helper that auto-includes new fields added to the schema without manual wiring. The pattern requires filtering out context/UI-sourced keys (`bookId`, `replaceExisting`) that don't come from SearchResult. Zod v4 `.shape` property is stable on `z.object()` instances.
