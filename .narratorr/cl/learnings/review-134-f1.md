---
scope: [frontend]
files: [src/client/pages/manual-import/pathUtils.ts]
issue: 134
source: review
date: 2026-03-26
---
When implementing a POSIX path ancestor check without `node:path`, normalizing `..` and `.` segments is required — not optional. The initial implementation only split on `/` and filtered empty strings, which correctly handles simple paths but treats `/audiobooks/../other` as inside `/audiobooks` (because `['audiobooks', '..', 'other']` prefix-matches `['audiobooks']` before `..` is evaluated). The fix is to process each segment: pop the stack for `..`, skip `.`, otherwise push. The spec correctly said "verify `path.relative()` result doesn't start with `..`" but the guide text "split on `/` and compare segments" from the implementation note failed to mention `..` resolution. A safer framing: "implement `path.normalize()` + `path.relative()` semantics using a stack-based segment processor."
