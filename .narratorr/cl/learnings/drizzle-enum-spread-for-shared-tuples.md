---
scope: [backend, db]
files: [src/db/schema.ts, src/shared/schemas/blacklist.ts]
issue: 321
date: 2026-04-05
---
Drizzle's `text('col', { enum: [...] })` expects a mutable array, not a readonly tuple. When passing an `as const` tuple from a shared module, use spread: `{ enum: [...BLACKLIST_REASONS] }`. This is the same pattern used for `SUGGESTION_REASONS` in the discovery schema. No migration is needed since SQLite ignores enum constraints — the change is purely for TypeScript narrowing.
