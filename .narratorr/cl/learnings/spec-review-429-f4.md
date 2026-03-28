---
scope: [scope/backend, scope/db]
files: []
issue: 429
source: spec-review
date: 2026-03-17
---
Blast radius section missed 9 notifier adapter test files that assert event titles/messages/payloads and will need import path updates when `NotificationEvent`/`EventPayload`/`formatEventMessage` move to shared. The Explore subagent found these maps but they weren't connected back to their corresponding test files. Would have been caught by: "for every source file in the blast radius, also glob for its co-located `.test.ts` file and add it to the list."
