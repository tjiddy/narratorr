---
scope: [scope/frontend]
files: [src/client/pages/manual-import/useFolderHistory.ts]
issue: 81
source: review
date: 2026-03-25
---
`readStorage()` filtered entries by checking only `path` is a string, not `lastUsedAt`. Entries missing `lastUsedAt` passed the filter and were then passed into `sortByRecency()` which calls `b.lastUsedAt.localeCompare(...)`, crashing on undefined.

Why missed: The filter was written defensively for `path` but not for `lastUsedAt`. The two fields are used together in a way that requires both to be valid — this was a partial guard.

What would have prevented it: Tracing all downstream uses of `readStorage()` output: it immediately goes into `sortByRecency()` which reads `lastUsedAt`. Any field read downstream of the filter must also be validated in the filter.
