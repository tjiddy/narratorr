---
scope: [frontend]
files: []
date: 2026-04-10
---
The `react-refresh/only-export-components` ESLint rule prevents `.tsx` files from exporting non-component values (helper functions, constants, types used as values). When a component file needs testable helpers or shared constants, put them in a separate `.ts` file from the start — don't co-locate and split later after the lint failure.
