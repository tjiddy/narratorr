---
scope: [frontend]
files: [src/client/components/DirectoryBrowserModal.tsx, src/client/pages/settings/LibrarySettingsSection.test.tsx]
issue: 50
source: review
date: 2026-03-21
---
When the test name claims "breadcrumb clicks do not submit the form" but the test body never actually clicks a breadcrumb button, the test is misleading and incomplete. This happened because the breadcrumb scenario was described in the test name but not implemented — only directory-row, Cancel, Close, and Select were exercised. Always verify that every action named in the test description maps to a userEvent call in the test body. When a regression fix touches N changed code paths (in this case 5 button type changes), write N interaction steps, one per changed control.
