---
scope: [frontend]
files: [src/client/pages/activity/ActivityPage.test.tsx]
issue: 478
source: review
date: 2026-04-11
---
When testing mutation error recovery that should re-enable a button, `mockRejectedValue` settles instantly — the disabled intermediate state is never observable. Use a deferred promise (`new Promise((_, reject) => { rejectFn = reject })`) to control timing: assert disabled while pending, then reject and assert re-enabled. Without this, the test passes even if `onMutate` never sets the disabling state.
