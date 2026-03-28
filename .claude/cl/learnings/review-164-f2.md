---
scope: [scope/frontend]
files: [src/client/pages/settings/SecuritySettings.test.tsx]
issue: 164
source: review
date: 2026-03-28
---
AuthModeSection uses both onSuccess and onError callbacks to clear showConfirm/pendingMode state. Tests asserted mutation args, refetches, and toasts but not confirmation dialog dismissal. If the callbacks were removed, tests still passed. Prevention: for any onSuccess/onError callback that drives dialog/confirmation state, the test must assert the element absence after settling on both success and error paths.
