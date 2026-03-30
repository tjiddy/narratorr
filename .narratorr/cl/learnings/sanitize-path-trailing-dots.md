---
scope: [core]
files: [src/core/utils/naming.ts, src/core/utils/naming.test.ts]
issue: 212
date: 2026-03-30
---
`sanitizePath()` strips trailing dots (Windows compatibility). When writing test assertions for comma-space separator collapse with values like "Last, First, Jr.", the trailing "." in "Jr." gets stripped by sanitizePath, producing "Jr" not "Jr.". Always trace the full transform pipeline (applyTokenTransforms → sanitizePath) before writing expected values.
