---
scope: [scope/frontend]
files: [src/client/pages/settings/GeneralSettingsForm.test.tsx, src/client/pages/settings/LibrarySettingsSection.test.tsx, src/client/pages/settings/SearchSettingsSection.test.tsx, src/client/pages/settings/ImportSettingsSection.test.tsx, src/client/pages/settings/QualitySettingsSection.test.tsx, src/client/pages/settings/NetworkSettingsSection.test.tsx, src/client/pages/settings/ProcessingSettingsSection.test.tsx]
issue: 341
source: review
date: 2026-03-12
---
Added zodResolver to all 7 forms but didn't add corresponding invalid-submit tests to verify the validation actually blocks submission. When adding validation, the test plan should include a negative test for each form that exercises the validation schema's constraints. Gap: implementation added validation without closing the test loop — every zodResolver addition needs at minimum one test proving invalid input is rejected with visible error feedback.
