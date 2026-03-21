---
scope: [frontend]
files: [src/client/pages/settings/LibrarySettingsSection.tsx]
issue: 18
date: 2026-03-21
---
When auto-saving a partial settings field (only library.path) on blur, use `queryClient.setQueryData` with a shallow merge rather than `queryClient.invalidateQueries`. Invalidating triggers a refetch which, via the useEffect reset, could wipe dirty sibling fields (folderFormat, fileFormat) if isDirty is momentarily false. setQueryData updates only the specific field in the cache, preserving dirty state for siblings and avoiding the race condition.
