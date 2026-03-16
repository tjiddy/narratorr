---
scope: [scope/frontend]
files: [src/client/components/AudioInfo.tsx]
issue: 363
source: spec-review
date: 2026-03-14
---
Reviewer caught that replacing emoji with SVG icons without marking them decorative (`aria-hidden="true"`) would make accessibility worse — screen readers would announce unlabeled graphics alongside the already-meaningful adjacent text.

Root cause: The spec was focused on visual consistency (emoji → icons) without considering the accessibility implications of the swap itself. Ironic for an accessibility issue.

Prevention: When replacing presentational elements (emoji, images, icons), always specify the ARIA treatment — decorative elements need `aria-hidden="true"`, meaningful elements need `aria-label`. This is especially critical when the issue is explicitly about accessibility.
