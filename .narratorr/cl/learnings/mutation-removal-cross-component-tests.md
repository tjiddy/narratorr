---
scope: [frontend]
files: [src/client/pages/settings/GeneralSettings.tsx, src/client/components/layout/Layout.test.tsx]
issue: 165
date: 2026-03-27
---
When removing a mutation from a component, audit sibling test files for cross-component integration tests that relied on the mutation → cache-invalidation → query-refetch → UI-update chain. Layout.test.tsx had two integration tests that rendered GeneralSettings as a child route specifically to verify that clicking "Show Welcome Message" caused Layout to re-show the welcome modal via cache invalidation. Those tests became void when the mutation was removed. Also check for associated imports and vi.mock() calls that were added exclusively for those tests; both the import and the mock should be removed together to prevent lint errors and dead setup code.
