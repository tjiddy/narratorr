---
scope: [scope/frontend, scope/services]
files: [src/client/pages/library/useLibraryFilters.ts, src/client/pages/library/LibraryPage.tsx]
issue: 372
source: spec-review
date: 2026-03-15
---
When adding pagination to a route whose frontend currently processes the full dataset client-side (search, sort, filter, aggregate), the spec must explicitly decide which operations move server-side vs remain client-side. Saying "filters work correctly with paginated data" without defining the mechanism leaves an ambiguous contract that will surface as a blocking review finding.
