---
scope: [frontend, api]
files: [src/client/pages/library-import/useLibraryImport.ts, src/client/lib/api/import.ts]
issue: 133
date: 2026-03-26
---
The library import (register existing books) flow reuses `api.confirmImport()` but passes `mode=undefined` instead of 'copy' or 'move'. The server treats `undefined` as in-place registration (no file operation). The `ImportSummaryBar` shows a Copy/Move mode selector by default — use `hideMode` prop to suppress it for in-place flows to avoid misleading the user.
