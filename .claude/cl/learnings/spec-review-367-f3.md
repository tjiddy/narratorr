---
scope: [scope/frontend]
files: []
issue: 367
source: spec-review
date: 2026-03-16
---
AC required two distinct empty states (no library books vs no suggestions) but the spec never defined how the frontend would distinguish them. The API contract didn't include a discriminator field like `libraryBookCount`. When a spec requires branching UI behavior, it must name the exact field or response shape that drives the branch — otherwise the AC is untestable.
