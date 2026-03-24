---
scope: [scope/backend, scope/frontend]
files: []
issue: 408
source: spec-review
date: 2026-03-17
---
The blast radius section only listed service/route/schema test files but missed the client settings form (`DiscoverySettingsSection.tsx`), its tests, the API type layer (`discover.ts`), and job tests. Root cause: blast radius was assessed by grepping for `discoverySettings` and `suggestions` but not for the downstream consumers of the settings schema (UI form) or the API type definitions that mirror the DB row shape. Would have been caught by tracing the full dependency chain: schema → settings registry → settings UI form, and schema → DB → service → route → API types → client.