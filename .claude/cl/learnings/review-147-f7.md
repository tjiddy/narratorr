---
scope: [scope/frontend]
files: [src/client/hooks/useMatchJob.ts, src/client/hooks/useMatchJob.test.ts]
issue: 147
source: review
date: 2026-03-27
---
The reviewer caught that useMatchJob's startMatching() non-Error fallback ('Unknown error') had no hook-level test. The existing test proved isMatching=false and error='Network error' for Error rejections, but not the fallback string for non-Error rejections.

Why we missed it: Same pattern as F1-F6. The issue is the sibling check in respond-to-pr-review step 3 was not applied broadly enough — after fixing F1-F5 in round 1, all remaining narrowing-fix sites in the diff should have been scanned for the same gap.

What would have prevented it: After fixing any instance of "missing non-Error test," run grep for all remaining ternary instanceof-Error fallbacks in the diff and add non-Error tests for each before pushing. Don't rely on the reviewer to enumerate them one batch at a time.
