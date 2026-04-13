---
scope: [backend, core]
files: [src/core/utils/index.ts, src/core/utils/filters.ts]
issue: 540
date: 2026-04-13
---
When creating a new module in `src/core/utils/`, add it to the barrel `index.ts` export BEFORE wiring consumers that import from the barrel. In this issue, wiring search-pipeline.ts to use `filterByLanguage` from `../../core/utils/index.js` caused 155 test failures because the barrel hadn't been updated yet. The fix was a one-line export addition, but sequencing it earlier would have avoided a confusing failure round.
