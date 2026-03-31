---
scope: [frontend]
files: [src/client/pages/search/SearchResults.tsx, src/client/pages/search/SearchPage.tsx]
issue: 246
date: 2026-03-31
---
Removing a prop from a component (like `isLoading` from `SearchResults`) requires updating all callers AND test helpers that pass it. The lint gate caught the unused variable, but test helpers also needed updating. When removing a prop, grep for `isLoading` across both source and test files.
