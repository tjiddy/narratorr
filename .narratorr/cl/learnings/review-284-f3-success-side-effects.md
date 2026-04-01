---
scope: [frontend]
files: [src/client/pages/settings/NewBookDefaultsSection.test.tsx]
issue: 284
source: review
date: 2026-04-01
---
When extracting a component with a mutation, test the full mutation lifecycle: not just the toast, but also dirty-state reset (save button disappears) and cache invalidation (settings query refetched). The original LibrarySettingsSection tests covered these but they weren't carried forward to the extracted component's test file.
