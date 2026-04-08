---
scope: [frontend]
files: [src/client/components/settings/indexer-fields/mam-fields.tsx, src/client/components/settings/indexer-fields/mam-detection-timing.ts]
issue: 416
date: 2026-04-08
---
The `react-refresh/only-export-components` ESLint rule prevents exporting non-component values (constants, functions) from files that also export React components. When extracting a testable constant from a component file, it must go in a separate `.ts` file (not the `.tsx` component file). This is why `getMinDetectionMs` lives in `mam-detection-timing.ts` rather than `mam-fields.tsx`.
