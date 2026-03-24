---
scope: [scope/frontend]
files: [src/client/components/layout/Layout.tsx, src/client/components/layout/Layout.test.tsx]
issue: 367
source: review
date: 2026-03-16
---
Nav integration tests only checked show/hide behavior for the Discover item but not its insertion order between Search and Activity. An ordering regression would pass silently. Prevention: when adding conditional nav items, test both presence/absence AND ordering of all nav labels.
