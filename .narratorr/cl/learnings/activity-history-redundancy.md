---
scope: [frontend, backend]
files: [src/client/pages/activity/ActivityPage.tsx, src/server/utils/download-side-effects.ts, src/client/pages/activity/useActivity.ts]
issue: 537
date: 2026-04-13
---
When merging two UI sections that appear to show different data, verify the underlying data stores first — `bookEvents` already captured most download lifecycle events, making `DownloadHistorySection` redundant. The spec initially proposed a complex client-side merge of two paginated endpoints (3 review rounds to resolve), but the actual fix was to remove the redundant section and fill two small event recording gaps (`setError` and `cancel` paths). Always grep for existing event writers before proposing new data pipelines.
