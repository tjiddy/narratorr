---
scope: [frontend]
files: [src/client/components/ManualAddForm.tsx]
issue: 246
source: review
date: 2026-03-31
---
When the spec says "behaves like existing add flow," hardcoding values that the existing flow derives from settings is a contract violation. Always grep the existing flow's resolution logic (AddBookPopover reads quality settings) and mirror it in new consumers.
