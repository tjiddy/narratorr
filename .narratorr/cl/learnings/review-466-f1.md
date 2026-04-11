---
scope: [frontend]
files: [src/client/pages/book/BookDetails.tsx, src/client/pages/book/BookDetails.test.tsx]
issue: 466
source: review
date: 2026-04-11
---
When changing resource ownership from explicit handler calls to effect cleanup, the existing tests that assert UI disappearance (no preview visible) are insufficient — they pass regardless of whether the cleanup effect actually fires. Must spy on the cleanup function (URL.revokeObjectURL) and assert it's called with the specific URL for each lifecycle path (confirm, cancel, unmount). The replace test already had this pattern but we didn't replicate it for the other paths.
