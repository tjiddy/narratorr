---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.tsx]
issue: 364
date: 2026-03-14
---
Grouping individual props into objects inline in JSX (e.g., `filterProps={{ ... }}`) adds lines to the parent component. If the parent is already near the `max-lines-per-function` lint limit, this will trigger a lint failure. Construct grouped prop objects before the JSX return to save lines.
