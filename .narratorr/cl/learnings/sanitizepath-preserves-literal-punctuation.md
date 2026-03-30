---
scope: [backend, core]
files: [src/core/utils/naming.ts]
issue: 231
date: 2026-03-30
---
`sanitizePath()` trims whitespace and trailing dots but does NOT strip literal punctuation like hyphens. A template `{title} - {partName}` with missing `partName` renders as `Title -`, not `Title`. To omit separators around missing tokens, use conditional syntax: `{title}{ - ?partName}`. This caused 3 spec review rounds before the test plan assertions matched reality. Always verify expected outputs against `sanitizePath` and `resolveTokens` source before writing test assertions for naming templates.
