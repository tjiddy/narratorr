---
scope: [frontend]
files: [src/client/components/PathInput.tsx, src/client/pages/settings/LibrarySettingsSection.tsx]
issue: 50
source: review
date: 2026-03-21
---
When extracting a shared component that wraps an <input>, always check whether the call site uses htmlFor on a <label> for that input — if so, the shared component needs an id prop forwarded to the inner <input>. The repo has an established FormField pattern that explicitly tests label/input linkage; new path-style inputs should follow the same pattern. This gap is caught by checking for htmlFor in the parent before finalizing the component API.
