---
scope: [scope/frontend]
files: [src/client/pages/activity/DownloadCard.test.tsx]
issue: 282
source: review
date: 2026-03-10
---
Pending-review tests claimed to verify panel collapse but only asserted button label/disabled state during the pending operation. The test names overstated what was actually protected. Fixed by renaming to accurately describe what's tested, adding panel visibility assertions, and adding a test that verifies the panel disappears when status changes away from pending_review. Lesson: test names are contracts — if a test says "collapses panel" it must assert the panel is gone, not just that a button is disabled.
