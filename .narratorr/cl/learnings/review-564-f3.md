---
scope: [frontend]
files: [src/client/pages/settings/BackupScheduleForm.test.tsx]
issue: 564
source: review
date: 2026-04-15
---
When migrating a form from always-rendered-disabled button to conditional `{isDirty && <button>}`, the dirty-state branch must be directly tested — asserting the button appears after a field change. Using `fireEvent.submit(form)` bypasses the button entirely, so tests pass even if the button never renders. Always test the UI gate, not just the mutation path.
