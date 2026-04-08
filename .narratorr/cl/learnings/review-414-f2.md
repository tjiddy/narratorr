---
scope: [frontend]
files: [src/client/pages/activity/ActivityPage.test.tsx, src/client/components/Pagination.tsx]
issue: 414
source: review
date: 2026-04-08
---
When a component hides at a threshold (e.g., `Pagination` returns `null` when `total <= limit`), asserting the component's absence does NOT prove the underlying state changed correctly. The component is gone regardless of whether page state clamped to 1 or stayed at 3. Fix: restore the data above the threshold and verify the component reappears with the expected state (Page 1, not the old page).
