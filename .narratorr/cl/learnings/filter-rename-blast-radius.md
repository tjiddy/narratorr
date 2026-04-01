---
scope: [frontend]
files: [src/client/pages/activity/EventHistorySection.tsx, src/client/pages/activity/ActivityPage.test.tsx]
issue: 260
date: 2026-04-01
---
Renaming filter chip labels can cause `getByRole('button', { name: /pattern/i })` collisions in parent component tests when the new label matches a tab or nav button. In #260, renaming a filter to "Downloads" collided with the "Downloads" tab button in ActivityPage. Always check parent integration tests when changing button labels — `getAllByRole` with index selection is the fix.
