---
scope: [frontend]
files: [src/client/pages/settings/CrudSettingsPage.tsx, src/client/pages/settings/CrudSettingsPage.test.tsx]
issue: 353
source: review
date: 2026-04-05
---
When `handleModalClose` has branching logic (create vs edit mode), test BOTH branches for both close triggers (Escape and backdrop). The implementation tested create-mode close and edit-mode pending-no-close, but missed the edit-mode success-path close through `handleCancelEdit`. Every branch × trigger combination needs coverage.