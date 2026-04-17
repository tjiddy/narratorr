---
scope: [frontend]
files: [src/client/components/book/MetadataResultItem.tsx, src/client/components/book/MetadataResultItem.test.tsx]
issue: 627
source: review
date: 2026-04-17
---
F1: When extracting shared components from two surfaces with different styling (MetadataSearchView uses gap-3 + hover border, BookEditModal uses gap-2.5 + no border), expose a `className` prop instead of hardcoding one surface's styles. The original class strings should be diffed line-by-line before extraction.

F3: Testing SVG icon presence via `querySelector('svg:last-child')` is vacuous when the component renders other SVGs in nested containers. Use `:scope > svg` to match only direct children of the parent element — this proves the badge SVG is rendered at the correct DOM level.
