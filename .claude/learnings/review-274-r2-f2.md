---
scope: [backend]
files: [apps/narratorr/src/server/services/download.service.ts, apps/narratorr/src/server/services/import.service.ts]
issue: 274
source: review
date: 2026-03-06
---
Event history `reason` JSON payloads were defined in the schema but not populated in the initial implementation. Each event emission site has contextual data available (grab has indexerId/size/protocol, import has targetPath/fileCount/totalSize, failure has error message) — these should always be captured as structured reason payloads for the event to be useful for debugging. Pattern: when designing fire-and-forget event recording, plan the reason payload at the same time as the event type.
