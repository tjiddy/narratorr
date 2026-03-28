---
scope: [frontend]
files: [src/client/components/manual-import/ImportCard.test.tsx]
issue: 163
source: review
date: 2026-03-27
---
When asserting SVG presence (or absence) in a component that renders multiple SVGs (icons in checkboxes, buttons, badges), always scope the querySelector to the specific container element — e.g., `badge.querySelector('svg')` or `badge.firstChild?.nodeName === 'svg'`. Using `container.querySelector('svg')` matches the first SVG in the entire rendered tree, which may be an unrelated icon in a neighboring element, making the assertion vacuous.
