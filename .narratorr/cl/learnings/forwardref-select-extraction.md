---
scope: [frontend]
files: [src/client/components/settings/SelectWithChevron.tsx]
issue: 216
date: 2026-03-30
---
When extracting a component that consumers spread RHF `register()` onto, the new component MUST use `forwardRef` — otherwise the `ref` from `register()` silently drops and form state stops updating. This is easy to miss because the component renders fine without it; only form dirty state and validation break.
