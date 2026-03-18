---
scope: [frontend]
files: [src/client/pages/settings/ProcessingSettingsSection.test.tsx]
issue: 198
source: review
date: 2026-03-12
---
Reviewer caught missing page-level save round-trip test and validation test. Render/prefill/typing tests don't prove the fields are included in the submitted payload or that validation errors surface on submit. When adding new settings fields, always include: (1) a save test that types values and asserts `api.updateSettings` receives them, and (2) a validation test that triggers the error path and asserts the error message appears + API not called.
