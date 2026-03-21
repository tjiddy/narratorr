---
scope: [frontend]
files: [src/client/pages/activity/DownloadActions.tsx, src/client/pages/activity/DownloadActions.test.tsx]
issue: 54
source: review
date: 2026-03-21
---
When adding a loading/pending UI state (disabled button + label swap) to a component, the in-flight UX branch needs its own component test. The existence test ("button renders") doesn't cover the disabled+loading-label variant. Pattern: always add a test with `isPending={true}` that asserts disabled state and label text for any new loading-state prop.
