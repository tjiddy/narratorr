---
scope: [frontend]
files: [src/client/components/icons.tsx, src/client/components/WelcomeModal.tsx]
issue: 159
date: 2026-03-27
---
When moving inline SVG icons to a shared module, verify the `strokeWidth` attribute matches exactly. The shared `BookOpenIcon` in `icons.tsx` used `strokeWidth="1.5"` while the inline WelcomeModal version used `"2"`. This produces a visible rendering difference even though the paths are identical. Always do a byte-level diff of SVG attributes when extracting, not just path data.
