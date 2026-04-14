---
scope: [frontend]
files: [src/client/App.tsx]
issue: 550
date: 2026-04-14
---
`React.lazy()` requires a module with a default export. All Narratorr page components use named exports with barrel re-exports. The workaround is `.then(m => ({ default: m.PageName }))` on the dynamic import. This pattern must be used every time a new page is added.
