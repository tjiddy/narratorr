---
scope: [scope/frontend]
files: [src/client/pages/settings/SecuritySettings.test.tsx]
issue: 164
source: review
date: 2026-03-28
---
When useMutationWithToast uses queryKey to invalidate a cache entry, the downstream observable is that the query refetches and the UI updates. A toast-only assertion proves the toast wiring but not the queryKey wiring — if the queryKey were wrong, the toast test still passes. Prevention: for each useMutationWithToast caller, the success test must also assert the invalidated query is refetched (clear the mock call count before the action, assert it is called after), and that the UI reflects the refreshed data. This is especially important when the refetch is the only mechanism that delivers the new value to the UI (e.g., a regenerated API key rendered from auth.config).
