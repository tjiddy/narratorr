---
scope: [core, backend]
files: [src/shared/schemas/book.ts, src/shared/schemas/activity.ts, src/shared/schemas/discovery.ts, src/db/schema.ts]
issue: 559
date: 2026-04-15
---
Zod v4 `z.enum([...]).options` returns `Array<T[keyof T]>` (a plain mutable array), not a readonly tuple like Zod v3. This means `schema.options` cannot be passed directly to Drizzle's `text('col', { enum: ... })` which expects `Readonly<[string, ...string[]]>`. The fix is to define values as `as const` tuples first and derive the Zod schema from them (`z.enum(TUPLE)`), matching the existing `INDEXER_TYPES` pattern. This would have been caught earlier by checking the Zod v4 type definitions before assuming the `.options` export pattern would work.
