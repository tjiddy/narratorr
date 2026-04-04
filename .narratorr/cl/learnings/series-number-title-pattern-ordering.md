---
scope: [core]
files: [src/server/services/library-scan.service.ts]
issue: 333
date: 2026-04-04
---
When adding a new regex pattern to a parser chain, the more specific pattern must come before the more general one. `Series – NN – Title` (requires `\d+` middle) must precede `Author - Title` (any two parts), otherwise the general pattern greedily captures the specific case. This aligns with CLAUDE.md's "variable-length parsing" gotcha.
