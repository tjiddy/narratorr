---
scope: [frontend, backend]
files: [src/shared/schemas/indexer.ts, src/client/components/settings/IndexerFields.test.tsx]
issue: 363
date: 2026-04-05
---
Changing a Zod field from `z.number()` to `z.enum([...])` narrows the inferred type to a string literal union. Any function returning values for that field (like coercion helpers) must return the literal union type, not bare `string`, or TypeScript rejects form `defaultValues` and `setValue` calls. Test wrapper components with `defaultValues` props also need the narrow type.
