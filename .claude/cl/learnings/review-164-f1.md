---
scope: [scope/frontend]
files: [src/client/components/settings/RemotePathMappingsSubsection.test.tsx]
issue: 164
source: review
date: 2026-03-28
---
When migrating a raw useMutation call to useMutationWithToast, the onSuccess callbacks are the primary behavioral concern introduced by the migration — they define UI state transitions (closing forms, clearing IDs). The existing tests only verified that API calls happened and toasts fired; they did not assert the UI side effects of the onSuccess callbacks. Prevention: whenever an onSuccess callback drives UI state (setShowForm, setEditingId, etc.), the migration test must include a waitFor that asserts the UI state change, not just the API call.
