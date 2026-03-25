---
scope: [scope/frontend, scope/services]
files: [src/client/pages/activity/ActivityPage.test.tsx, src/client/pages/activity/useActivity.ts, src/client/hooks/useEventHistory.ts, src/client/hooks/useLibrary.ts, src/client/pages/settings/BlacklistSettings.tsx]
issue: 93
source: review
date: 2026-03-25
---
When writing pagination clamp tests, don't test `usePagination.clampToTotal` in isolation via `renderHook` — test the page-level `useEffect` wiring that calls it. The hook-level tests duplicate existing coverage in `usePagination.test.ts` without proving that `ActivityPage` actually wires `queueTotal` into `clampToTotal`.

Root cause: TanStack Query sets `data = undefined` when the query key changes during page navigation (no `placeholderData`). This causes `queueTotal = 0`, the clamp fires and resets the page to 1 on every Next-page click, making page-level tests appear impossible. The fix is to add `placeholderData: (prev) => prev` to the paginated query — this is a real production bug that prevents pagination navigation from working, not just a test concern.

What would have prevented it: during spec/explore phase, verify that pagination navigation actually works end-to-end (nav to page 2, data stays stable). Also: all paginated `useQuery` calls that pair with a `clampToTotal` `useEffect` need `placeholderData: (prev) => prev` to prevent mid-navigation total flicker. Check sibling patterns in `useEventHistory.ts`, `useLibrary.ts`, and `BlacklistSettings.tsx`.
