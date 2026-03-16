---
scope: [scope/frontend]
files: [src/client/lib/queryKeys.ts, src/client/pages/activity/useActivity.ts, src/client/hooks/useLibrary.ts, src/client/hooks/useActivityCounts.ts, src/client/hooks/useEventHistory.ts]
issue: 283
source: spec-review
date: 2026-03-10
---
Spec said "relevant queries invalidated" for SSE events without mapping which specific query keys each event should invalidate. The frontend has 5+ separate query key families (activity, activityCounts, books, book(id), eventHistory) and each event type affects a different subset. Prevention: for any spec that involves cache invalidation or real-time updates, build an explicit event-to-cache matrix mapping each event to affected query keys and the invalidation strategy (patch vs full invalidate).
