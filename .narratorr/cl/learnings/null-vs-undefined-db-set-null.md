---
scope: [frontend, backend]
files: [src/client/lib/api/activity.ts, src/db/schema.ts]
issue: 48
date: 2026-03-21
---
When a Drizzle FK column uses `onDelete: 'set null'`, the DB sends `NULL` which the service passes through as JavaScript `null` — not `undefined`. Client TypeScript interfaces typed as `bookId?: number` (i.e., `number | undefined`) are wrong for this case and must be widened to `number | null | undefined`. Guards must use `!= null` (loose equality, catches both) not `!== undefined` (strict, misses null). The spec review process caught this — the first implementation draft only guarded against `undefined`.
