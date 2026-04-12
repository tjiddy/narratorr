---
scope: [frontend]
files: [src/client/pages/settings/SecuritySettings.tsx]
issue: 512
date: 2026-04-12
---
When using `useMutationWithToast` with a ConfirmModal, never add an `onError` callback that closes the modal — the hook already handles error toasts automatically, and closing on error prevents the user from retrying. Only `onSuccess` should manage modal state. This pattern was already correct in `ApiKeySection` but regressed in `AuthModeSection` during the #488 ConfirmModal migration.
