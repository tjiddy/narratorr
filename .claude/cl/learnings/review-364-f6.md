---
scope: [frontend]
files: [src/client/components/SearchReleasesModal.test.tsx, src/client/pages/settings/ImportListsSettingsSection.test.tsx]
issue: 364
source: review
date: 2026-03-14
---
When adding duplicate-key collision handling to multiple render sites, the collision test coverage must be added to ALL render sites — not just one representative component. In round 2, collision tests were added for SearchTabContent but not for SearchReleasesModal or ImportListsSettings preview, leaving two render sites unguarded against regression. When a fix is applied to N sibling sites, write N collision tests — one per site.
