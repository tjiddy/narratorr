---
scope: [frontend]
files: [src/client/pages/activity/DownloadCard.tsx, src/client/pages/activity/QualityComparisonPanel.test.tsx]
issue: 282
date: 2026-03-10
---
When moving buttons behind an expand/collapse toggle, ALL existing tests that click those buttons must be updated to expand first. Use `screen.getByRole('button', { expanded: false })` to find the toggle, click it, then assert/interact with the revealed content. This broke 8 tests across 2 files — easy to miss if you only run the component's own test file.
