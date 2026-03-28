---
scope: [scope/backend]
files: []
issue: 408
source: spec-review
date: 2026-03-17
---
AC4 was worded as "re-score suggestions that share author/series/genre" which implied a narrower matching algorithm, when the existing `refreshSuggestions()` already does a full-library recompute that handles this naturally. The reviewer flagged the ambiguity about whether to build a new narrower path or rely on the existing full refresh. Root cause: the AC was written without checking how the current refresh pipeline works in `discovery.service.ts:94-117`. Would have been caught by verifying the existing implementation path before writing ACs that describe behavioral changes on top of it.