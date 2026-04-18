---
scope: [backend, services]
files: [src/server/services/import-adapters/manual.ts]
issue: 636
source: review
date: 2026-04-18
---
ManualImportAdapter failure event was created without `reason: { error: message }`, which the UI's EventHistoryCard and eventReasonFormatters.tsx depend on to show failure details. When adding event history recording in a new code path, always check what fields the UI renderer expects — the CreateEventInput type allows optional `reason` but the UI conditionally shows "View details" based on its presence.
