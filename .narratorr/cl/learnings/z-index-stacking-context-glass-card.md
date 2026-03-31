---
scope: [frontend]
files: [src/client/components/settings/DownloadClientFields.tsx]
issue: 234
date: 2026-03-31
---
When a dropdown is inside a component that's a sibling of `glass-card` elements (which have `backdrop-filter` creating new stacking contexts), the dropdown's z-index alone isn't enough — the parent container needs its own z-index to establish a higher stacking context. In this case, adding `z-40` to the `relative` parent of a `z-30` dropdown fixed the issue. Per CSS-1 scale: z-10 sticky headers, z-30 dropdowns, z-40 popovers, z-50 modals.
