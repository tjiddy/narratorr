---
scope: [backend, core]
files: [src/db/schema.ts, src/server/services/download-orchestrator.ts, src/server/services/enrichment-orchestration.helper.ts, src/server/services/health-check.service.ts]
issue: 559
date: 2026-04-15
---
Removing `as unknown as [string, ...string[]]` casts from Drizzle schema columns tightens the inferred types of those columns. Downstream code that previously used `string` where enum literals are now required will fail typecheck. In this case, 3 service files needed type narrowing fixes: `updateStatus(status: string)` → `updateStatus(status: DownloadStatus)`, `Partial<{ enrichmentStatus: string }>` → `Partial<{ enrichmentStatus: EnrichmentStatus }>`, and an `inArray()` call that had its own `as unknown as string[]` cast. Always grep for consumers of the affected DB columns before removing casts.
