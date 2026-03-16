---
scope: [scope/db, scope/services]
files: [src/db/schema.ts, src/server/jobs/monitor.ts, src/server/services/import.service.ts, src/server/services/quality-gate.service.ts, src/server/utils/download-path.ts]
issue: 365
source: spec-review
date: 2026-03-15
---
Spec review caught that M-17 (downloads.downloadClientId cascade) mischaracterized `onDelete: 'set null'` as leaving "zombie records" when it's actually intentional. Four service/job sites (monitor.ts:62-65, download-path.ts:15-16, quality-gate.service.ts:465-471, import.service.ts:590) defensively handle null `downloadClientId` for in-flight and historical downloads. Switching to cascade would delete rows that current code expects to survive.

Root cause: `/elaborate` trusted the debt scan finding's characterization ("zombie download records") without reading the downstream code that handles the null case. The label "zombie" implied uselessness, but the null-client downloads are actively handled as part of the download lifecycle.

Prevention: When a spec proposes changing FK cascade behavior, always read the code paths that handle the current nullable/null state. If multiple callers guard for null, the nullable behavior is likely intentional, not accidental.
