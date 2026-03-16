---
scope: [scope/frontend]
files: [src/client/pages/settings/SearchSettingsSection.tsx]
issue: 341
source: review
date: 2026-03-12
---
When adding inline error rendering to a form with multiple validated fields, only added the error message to the first field (searchIntervalMinutes) and missed the other two (blacklistTtlDays, rssIntervalMinutes). Gap: didn't systematically audit all fields with `errors.*` conditional borders to ensure each one also has a corresponding `.message` render. When fixing validation display, check every field that uses `errors.fieldName` in the component, not just the one the test targets.
