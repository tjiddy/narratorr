---
scope: [frontend]
files: [src/client/pages/activity/ActivityPage.tsx, src/client/pages/activity/ActivityPage.test.tsx]
issue: 306
source: review
date: 2026-04-02
---
When splitting a shared mutation prop into per-row derived values (e.g., `rejectMutation.variables?.id === download.id`), the DownloadCard-level tests prove the child respects props correctly, but they don't prove the parent derives them correctly. A page-level test with multiple rows is needed to catch regressions where the parent reverts to a single boolean. The self-review and coverage subagent both noted this gap but I proceeded anyway — should have treated the coverage finding as blocking.
