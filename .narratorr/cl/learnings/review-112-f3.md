---
scope: [scope/backend]
files: [src/server/services/merge.service.ts]
issue: 112
source: review
date: 2026-03-26
---
The commit step's originals deletion loop could unlink the merged output file if an original had the same basename as the staged M4B (e.g., a pre-existing Title.m4b alongside chapter files). After rename() moves the staged file, iterating originalsToDelete without excluding the output name would delete what was just moved in.

Why we missed it: the "happy path" test used only .mp3 originals, so there was no collision. The failure mode only occurs when the source directory already contains a .m4b file, which is an edge case not covered in the test matrix.

What would have prevented it: after `rename()` moves the staged file to the target, the deletion loop should always exclude files whose basename matches `stagedM4b`. Test plans for commit steps should include "original has same basename as output" as an explicit test case.
