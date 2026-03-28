---
scope: [frontend]
files: [src/client/pages/settings/LibrarySettingsSection.tsx, src/client/pages/library/useLibraryMutations.ts]
issue: 18
source: review
date: 2026-03-21
---
When duplicating a rescan mutation in a new location (settings page), the books-query invalidation from the existing rescan path in useLibraryMutations.ts was not carried over. rescanLibrary() mutates book status on the server, so cached books data becomes stale without invalidation. Fix: always add `queryClient.invalidateQueries({ queryKey: queryKeys.books() })` wherever rescanLibrary() is called on success. When copying/adapting an existing mutation pattern, check the original's onSuccess for all side effects (toasts AND cache invalidations) and replicate them.
