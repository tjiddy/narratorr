---
scope: [backend, core]
files: [src/shared/schemas/indexer.ts, src/shared/schemas/download-client.ts, src/shared/schemas/notifier.ts, src/shared/schemas/import-list.ts]
issue: 557
date: 2026-04-15
---
`z.discriminatedUnion` is incompatible with `crud-routes.ts`'s test-endpoint pattern that calls `createSchema.extend()` — `ZodDiscriminatedUnion` has no `.extend()` method. Using `z.object()` with `superRefine` that validates settings against a per-type schema map achieves the same typed validation while keeping the create schema as a `ZodObject` for extension compatibility. The per-type schemas do the actual strict validation via `safeParse` inside superRefine.
