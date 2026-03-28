---
scope: [frontend]
files: [src/client/pages/manual-import/useManualImport.test.ts]
issue: 114
source: review
date: 2026-03-25
---
Select-all implicitly force-importing duplicates is correct per spec, but without an explicit test the reviewer can't tell if it's intentional or accidental. When a behavior has surprising/non-obvious consequences (here: bulk-selecting bypasses the duplicate safety-net), always add a test that names the intent. Similarly, the all-duplicate guard (`candidates.length > 0` before `startMatching()`) was tested for the review-step outcome but not for the absence of the match API call — add `expect(startMatchJob).not.toHaveBeenCalled()` to close that gap.
