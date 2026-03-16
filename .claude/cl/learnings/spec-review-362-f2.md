---
scope: [scope/frontend]
files: [src/client/pages/settings/BackupScheduleForm.test.tsx, src/client/pages/settings/NetworkSettingsSection.test.tsx]
issue: 362
source: spec-review
date: 2026-03-13
---
Reviewer caught that AC2 said "All fireEvent.submit calls" should be replaced, but there are 41 instances across 10 files while the findings section only named 2 BackupScheduleForm cases. Additionally, `NetworkSettingsSection.test.tsx:278` uses intentional direct `fireEvent.submit` because re-typing the same value doesn't make RHF dirty. The fix: when writing AC for cleanup issues, scope to exact file:line instances, not "all X". Always check for valid uses of the pattern being cleaned up.
