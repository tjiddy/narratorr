---
scope: [core]
files: [src/core/utils/naming.ts]
issue: 228
date: 2026-03-30
---
`renderTemplate()` splits on `/`, trims each segment, and filters empties. This means prefix text with leading spaces (e.g., `{ - ?series}` at the start of a segment) gets trimmed. Test assertions for `renderTemplate` must account for this; use `renderFilename` for testing prefix rendering in isolation since it doesn't split on `/`.
