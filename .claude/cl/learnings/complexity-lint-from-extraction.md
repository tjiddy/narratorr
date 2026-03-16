---
scope: [backend]
files: [src/server/jobs/monitor.ts]
issue: 360
date: 2026-03-14
---
When extracting inline code into a helper function, the helper inherits the combined complexity of all the logic you moved into it. In #360, `processDownloadUpdate` had complexity 19 (max 15) because it consolidated progress update, SSE emission, failure transitions, and completion notification. Had to further decompose into `emitProgressEvents`, `handleFailureTransition`, and `handleCompletionNotification`. Plan for this — if the original function was already complex, simply moving code to a new function doesn't reduce complexity.
