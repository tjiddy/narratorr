---
scope: [core]
files: [src/core/metadata/audible.ts, src/core/metadata/audible.test.ts, src/core/metadata/audnexus.ts, src/core/metadata/audnexus.test.ts]
issue: 94
date: 2026-03-26
---
The handoff coverage gate checks ALL behaviors in changed source files, not just lines changed by the branch. A focused refactor (e.g., `request()` internals only) can still trigger a coverage failure because co-located public methods like `searchAuthors()` and `searchSeries()` had no tests in the same file. Write tests for the entire file before claiming the file is "covered," not just the changed lines.
