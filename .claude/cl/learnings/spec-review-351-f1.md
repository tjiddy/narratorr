---
scope: [scope/frontend]
files: [src/client/pages/library/useLibraryFilters.ts]
issue: 351
source: spec-review
date: 2026-03-14
---
Reviewer caught that AC7 ("StatusPills renders correct counts") can't be satisfied without also modifying `useLibraryFilters.ts`, which builds the `statusCounts` record that `StatusPills` receives as a prop. The spec only named `helpers.ts` and `StatusPills.tsx` in scope, missing the intermediate data source.

Root cause: Traced the UI component (StatusPills) but didn't follow the prop upstream to its source (`useLibraryFilters.statusCounts`). When adding new values to a type union used in a `Record<T, number>`, every site that initializes that record must be updated — the spec should trace the full data flow from source to render.
