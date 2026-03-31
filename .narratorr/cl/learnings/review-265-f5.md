---
scope: [frontend]
files: [src/client/pages/settings/LibrarySettingsSection.test.tsx]
issue: 265
source: review
date: 2026-03-31
---
When testing that dirty form state survives a settings refetch, the test must actually trigger a query invalidation (e.g., `queryClient.invalidateQueries()`) and wait for `getSettings` to be called again — not just swap the mock return value. Without invalidation, React Query never refetches, so the useEffect guard is never exercised and the test is vacuous. Pass a custom `QueryClient` instance via `renderWithProviders` to get a handle for invalidation.
