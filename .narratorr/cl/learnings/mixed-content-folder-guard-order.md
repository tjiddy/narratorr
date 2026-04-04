---
scope: [core]
files: [src/core/utils/book-discovery.ts]
issue: 334
date: 2026-04-04
---
When fixing a guard clause that returns early, the fix must NOT just remove the return — it must restructure the conditional so the early-return case becomes the `else if` branch and the new fall-through case is the `if` branch. The existing test for the old buggy behavior ("treats parent as leaf when it has its own audio, does not recurse into children") was testing the exact scenario the bug fix corrects, so it needed updating — not deleting.
