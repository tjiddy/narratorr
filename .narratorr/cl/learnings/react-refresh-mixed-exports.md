---
scope: [frontend]
files: [src/client/lib/eventReasonFormatters.tsx, src/client/lib/eventReasonHelpers.ts]
issue: 455
date: 2026-04-09
---
`react-refresh/only-export-components` lint rule blocks `.tsx` files from exporting non-component values (functions, constants). When a utility file needs both pure helper functions and React components, split into `.ts` (helpers) and `.tsx` (components). This came up when `hasReasonContent()` and `getEventSummary()` shared a file with `EventReasonDetails` — had to extract helpers to a separate `.ts` file to pass lint.
