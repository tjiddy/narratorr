---
scope: [core]
files: [src/core/utils/naming.ts]
issue: 240
source: review
date: 2026-03-31
---
Post-processing regex that strips ALL empty `()` / `[]` is too broad — it catches literal empty wrappers not produced by tokens. Use a sentinel character during token resolution to mark empty-token positions, then only strip wrappers containing the sentinel. The self-review missed this because the tests only covered token-produced wrappers.
