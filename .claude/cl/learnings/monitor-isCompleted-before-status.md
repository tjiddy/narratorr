---
scope: [backend]
files: [src/server/jobs/monitor.ts]
issue: 117
date: 2026-03-25
---
In `processDownloadUpdate()`, the `isCompleted = progress >= 1` guard ran BEFORE checking adapter status. Any adapter that hardcodes `progress: 100` for history items (SABnzbd, NZBGet) would send failed downloads to the completion path. The fix is to derive `isError = item.status === 'error'` first, then `isCompleted = !isError && progress >= 1`. This pattern — guard on semantic status before numerical threshold — should be applied any time a numerical field could be misleadingly saturated by a non-completion state.
