---
scope: [backend]
files: [src/server/services/import.service.ts]
issue: 525
date: 2026-04-13
---
Drizzle ORM's `db.update()` return type doesn't expose `rowsAffected` directly — it needs `(result as unknown as { rowsAffected?: number }).rowsAffected`. This pattern is already used in `discovery.service.ts:193` and should be followed whenever checking CAS-style update success.
