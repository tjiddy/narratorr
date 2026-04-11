---
scope: [frontend]
files: [src/client/components/ConfirmModal.tsx, src/client/pages/settings/SecuritySettings.tsx]
issue: 488
source: review
date: 2026-04-11
---
When migrating inline confirm buttons to ConfirmModal, the old inline buttons had `disabled={mutation.isPending}` and dynamic pending labels. ConfirmModal didn't have a `confirmDisabled` prop, so these guards were silently dropped. Any future migration from inline confirms to ConfirmModal must check for pending-state guards. The fix was to add `confirmDisabled` prop to ConfirmModal — a clean extension that any consumer can opt into.
