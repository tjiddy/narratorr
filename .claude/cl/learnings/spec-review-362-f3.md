---
scope: [scope/frontend]
files: [src/client/pages/settings/BackupScheduleForm.tsx]
issue: 362
source: spec-review
date: 2026-03-13
---
Reviewer caught that the test plan said the save button is "not rendered when form is clean" but BackupScheduleForm uses `disabled={!isDirty}` (always rendered, disabled when clean), unlike QualitySettingsSection which uses `{isDirty && (...)}` (conditionally rendered). The fix: when writing test plan items about form submit behavior, read the actual component source to determine whether the submit button is conditionally rendered vs always-rendered-but-disabled. These are two different patterns that require different test assertions.
