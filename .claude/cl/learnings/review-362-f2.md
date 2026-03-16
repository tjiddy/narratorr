---
scope: [scope/frontend]
files: [src/client/pages/settings/BackupScheduleForm.test.tsx]
issue: 362
source: review
date: 2026-03-13
---
Reviewer caught that BackupScheduleForm tests didn't assert the save button is disabled when the form is clean, even though the component gates on `isDirty`. When keeping `fireEvent.submit` as a workaround for jsdom constraints, the disabled-state contract should still be tested separately — the workaround bypasses the gating, so a dedicated assertion is needed to prevent regressions where submit becomes accidentally enabled.
