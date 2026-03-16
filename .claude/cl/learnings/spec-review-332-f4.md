---
scope: [scope/backend]
files: []
issue: 332
source: spec-review
date: 2026-03-10
---
Reviewer caught that the spec described event-pruning cutoff as "Unix seconds" when Drizzle's `{ mode: 'timestamp' }` on integer columns presents values as `Date` objects in the service layer. The existing `BlacklistService.deleteExpired()` already uses `new Date()` comparisons, which should have been the model. Root cause: the spec author looked at the SQLite storage format (integer seconds) instead of the Drizzle ORM contract that the service code actually uses. Prevention: when specifying timestamp comparisons, check how existing service methods compare against timestamp columns (grep for `new Date` / `lte` / `gt` patterns in services) rather than reasoning from the raw DB schema.
