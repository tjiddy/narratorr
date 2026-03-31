---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.tsx, src/client/pages/library/BulkActionToolbar.tsx]
issue: 238
date: 2026-03-31
---
When adding a computed aggregate prop (like file count sum) to a toolbar component, the calculation should live in the page/container that has access to the selection data, not in the toolbar itself. The toolbar receives the pre-computed value as a prop. This keeps the toolbar stateless and testable with simple prop values.
