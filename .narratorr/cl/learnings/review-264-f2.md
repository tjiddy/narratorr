---
scope: [frontend]
files: [src/client/pages/settings/ImportListsSettingsSection.test.tsx]
issue: 264
source: review
date: 2026-04-01
---
ImportListsSettings has a separate implementation path from the shared CrudSettingsPage, so any test gap in the shared path also needs independent coverage here. The pending-state Cancel test was missing in both implementations. When the spec says "independent implementation — does not use CrudSettingsPage," that means test coverage for the same behavior must be duplicated, not assumed shared.
