---
scope: [frontend]
files: [src/client/pages/activity/ActivityPage.test.tsx]
issue: 488
date: 2026-04-11
---
ActivityPage test file has a `beforeEach` inside the main `describe` block (line 107) but new top-level `describe` blocks at the bottom don't inherit that setup. Tests added outside the main describe must mock `api.getActivity` and `api.getEventHistory` themselves, or the component stays in loading state and tab buttons never render. The `mockActivitySections` helper only mocks `getActivity` — `getEventHistory` must be mocked separately for tests that need the full loaded state.
