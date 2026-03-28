---
scope: [frontend]
files: [src/client/pages/library-import/LibraryImportPage.tsx]
issue: 133
source: review
date: 2026-03-26
---
When a spec says "hidden by default with a toggle", a passive label is not sufficient — the implementation must maintain toggle state and conditionally render rows. A static count badge does not satisfy an interactive hide/show requirement. Check spec language carefully: "hidden/shown" means interactive toggle state, not informational text.
