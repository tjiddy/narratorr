---
scope: [backend, core]
files: [apps/narratorr/src/server/services/download.service.ts, apps/narratorr/src/server/services/import.service.ts, apps/narratorr/src/server/services/rename.service.ts, apps/narratorr/src/server/routes/books.ts]
issue: 274
source: review
date: 2026-03-06
---
Reviewer caught that EventHistoryService.create() existed but no lifecycle service called it — the event history system was read/write surfaces only with no producers. The AC explicitly said "Events recorded for grabbed/download/import/delete/rename lifecycle" but the implementation only built the recording API and UI, not the actual producer wiring. This was flagged as "by-design debt" in the claim but the AC required it. Prevention: treat each AC item as a checklist gate — if the AC says "events recorded for X flows", the implementation must include the producer calls, not just the recording API.
