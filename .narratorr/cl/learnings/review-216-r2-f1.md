---
scope: [frontend]
files: [src/client/pages/settings/ImportListsSettingsSection.test.tsx, src/client/pages/settings/ImportListProviderSettings.tsx]
issue: 216
source: review
date: 2026-03-30
---
When testing a conditional rendering branch (e.g., select appears after data fetch), asserting that the element renders is only half the coverage. The onChange handler on the new branch is also new code that needs an interaction assertion — select an option and verify the value propagates. "It renders" ≠ "it works."
