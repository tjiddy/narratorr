---
scope: [backend]
files: [src/server/services/discovery.service.ts]
issue: 408
date: 2026-03-17
---
Drizzle ORM's SQLite delete() result doesn't have a typed rowsAffected property. Need to cast via `(result as unknown as { rowsAffected?: number }).rowsAffected ?? 0` to safely access it. The ?? 0 fallback prevents crashes if the property is undefined.
