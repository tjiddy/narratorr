---
scope: [frontend]
files: [src/client/pages/search/SearchResults.tsx]
issue: 99
date: 2026-03-25
---
When removing component renders, check the full import list — `BookOpenIcon` was used both in the removed empty-state render AND in the `SearchTabBar` subcomponent inside the same file. Removing the import along with the empty-state block broke `SearchTabBar`. Always grep the file for each removed symbol before deleting its import.
