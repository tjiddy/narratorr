---
scope: [backend, core]
files: [src/client/pages/settings/QualitySettingsSection.tsx]
issue: 272
source: review
date: 2026-04-01
---
Adding a new settings field to the schema/defaults/pipeline without adding the corresponding UI control means users can't configure the feature. The spec AC said "New preferredLanguage quality setting" which implies UI, but implementation only covered the backend plumbing. Always check whether a settings field needs a UI control in the settings section component.
