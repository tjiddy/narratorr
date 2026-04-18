---
scope: [frontend]
files: [src/client/pages/activity/ImportActivityCard.tsx, src/client/hooks/useEventSource.ts]
issue: 650
source: review
date: 2026-04-18
---
The reviewer caught that `_byteCounter` from the copy phase persists into the renaming phase because `import_phase_change` only triggers `invalidateQueries` (async refetch) — the old cached data stays visible until the refetch completes. Since the renaming formatProgress branch formats any existing `_byteCounter` as file counts, stale copy byte values (12000000/28000000) would render as file counts. Fix: store `_progressPhase` in the SSE patch and only pass progress/byteCounter to PhaseRow when it matches the current entry's phase. This is a general pattern: when adding a new consumer of cached transient state, verify the cache lifecycle matches the consumer's assumptions about data freshness.
