---
scope: [scope/core, scope/services]
files: [src/server/services/enrichment-utils.test.ts, src/server/services/match-job.service.test.ts, src/server/services/quality-gate-orchestrator.test.ts, src/server/services/merge.service.test.ts, src/server/services/import.service.test.ts, src/server/services/bulk-operation.service.test.ts, src/server/services/library-scan.service.test.ts]
issue: 434
source: review
date: 2026-04-09
---
Reviewer caught that caller-threading assertions were missing or too weak (using `expect.any(String)` instead of exact derived values). Multiple service tests would still pass if the ffprobePath threading was deleted or mis-wired.

Missed because: the implementation focused on testing the core helper and scanner integration thoroughly, then treated caller tests as "just update the fixture shape" — without adding assertions that the new parameter actually flows through with the correct derived value. The spec's "Caller test fixture updates" section listed files that needed changes but didn't emphasize that each needs a positive assertion for the configured case.

Prevention: when threading a new parameter through N callers, each caller test must assert both the configured case (exact derived value) and the no-config case (undefined). `expect.any(String)` is never sufficient for a derived value.
