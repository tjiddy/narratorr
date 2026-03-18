---
scope: [scope/backend]
files: [src/server/services/discovery.service.ts]
issue: 418
date: 2026-03-17
---
When removing lines from a file that has `/* eslint-disable */` at the top, check whether the disable is still needed. In this case, the file was 517 lines with a max-lines limit of 400 — removing 2 lines didn't bring it under the limit, so the disable was still required. Removing it broke lint on the first verify.ts run.
