---
scope: [backend]
files: [src/server/utils/serialize-error.ts]
issue: 621
date: 2026-04-17
---
When using a `Set<unknown>` seen-tracker for circular reference detection in recursive cause chain serialization, the initial error must be added to the set before the first recursion call. Starting with `new Set()` and only adding inside the recursive function misses the self-referential case (`error.cause === error`) because the root error isn't in the set when its own cause is checked.
