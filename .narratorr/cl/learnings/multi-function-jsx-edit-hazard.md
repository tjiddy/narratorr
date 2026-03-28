---
scope: [frontend]
files: [src/client/components/SearchReleasesModal.tsx]
issue: 161
date: 2026-03-28
---
When a TSX file contains multiple exported functions (SearchReleasesModal, UnsupportedSection, ReleaseCard), editing the closing JSX tags of one function can accidentally target the wrong function if both end with `</div>`. The SearchReleasesModal edit accidentally replaced a `</div>` in ReleaseCard (which also ends with `</div>`), causing an esbuild parse error. Fix: always include enough context in old_string to uniquely identify the target — include the full closing sequence with unique adjacent siblings, not just a bare closing tag.
