---
scope: [frontend]
files: [src/client/pages/settings/LibrarySettingsSection.tsx]
issue: 265
source: review
date: 2026-03-31
---
When adding a `useEffect` that resets form state from fetched data, always add a dirty guard (`!isDirty`) to prevent overwriting unsaved user edits on refetch. The existing path form had this guard at line 37, but the new defaults form copied the reset pattern without it. The self-review should have compared the two effects side-by-side.
