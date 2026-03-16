---
scope: [frontend]
files: [src/client/lib/stableKeys.ts, src/client/pages/search/SearchTabContent.tsx, src/client/components/SearchReleasesModal.tsx, src/client/pages/settings/ImportListsSettings.tsx]
issue: 364
source: review
date: 2026-03-14
---
Adding a helper function (deduplicateKeys) without wiring it into the call sites is a no-op. After round 1 fixed the key functions to be purely field-based, the duplicate collision case was left unhandled — deduplicateKeys existed but was never called by any component. Always verify that new utility functions are actually imported and used by their intended consumers before considering the work done.
