---
scope: [scope/frontend, scope/ui]
files: [src/client/pages/settings/GeneralSettings.tsx, src/client/pages/settings/GeneralSettingsForm.tsx, src/client/pages/settings/SystemSettings.tsx]
issue: 157
source: review
date: 2026-03-27
---
The spec said "Settings → General" but GeneralSettingsForm is mounted from SystemSettings.tsx, not GeneralSettings.tsx. Adding a feature to GeneralSettingsForm places it in Settings → System, not General.

Why: Saw "General" in the component name and assumed it was on the General page. Didn't trace the actual mount point before deciding where to add the escape hatch.

What would have prevented it: Before adding a UI element to an existing component, grep every file that imports it to verify it lands on the correct page. The spec's navigation path is a testable assertion — test the page-level component (GeneralSettings) rather than the form directly, which would have exposed the wrong mount point at test-writing time.
