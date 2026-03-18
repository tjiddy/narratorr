---
scope: [scope/frontend, scope/ui]
files: [src/client/pages/discover/DiscoverySettingsSection.test.tsx]
issue: 367
source: review
date: 2026-03-17
---
Reviewer caught that the save-success test for DiscoverySettingsSection didn't assert `queryClient.invalidateQueries({ queryKey: queryKeys.settings() })`. The test only checked toast and dirty-state reset, which would still pass if the invalidation call were deleted. Fix: spy on `QueryClient.prototype.invalidateQueries` and assert the exact queryKey. This is a recurring gap — when testing mutation `onSuccess` callbacks, every side effect (cache invalidation, toast, state reset) needs its own assertion. Toast + UI alone don't prove cache coherency.
