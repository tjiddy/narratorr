---
scope: [frontend]
files: [src/client/pages/settings/DownloadClientsSettings.test.tsx, src/client/components/settings/DownloadClientForm.tsx]
issue: 263
source: review
date: 2026-04-01
---
Reviewer caught that the new `pathMappings` field was only proven at the form boundary (DownloadClientForm.test.tsx) but never tested through the full page stack (DownloadClientsSettings → CrudSettingsPage → useCrudSettings → api.createClient). A regression in the form→card→page→hook→API wiring could silently drop pathMappings while all component-level tests still pass. Root cause: self-review coverage subagent flagged this as "implicit" but didn't escalate it to blocking. Lesson: when a new field is added to a form that goes through a generic CRUD stack, always add a page-level interaction test that submits through the full chain and asserts the API receives the field.
