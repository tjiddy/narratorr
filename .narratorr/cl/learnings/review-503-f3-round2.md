---
scope: [backend]
files: [src/server/services/search-pipeline.test.ts]
issue: 503
source: review
date: 2026-04-12
---
When a function has multiple call paths (non-broadcaster, broadcaster, postProcessSearchResults), adding tests for one path doesn't cover the others. The reviewer caught that only `searchAndGrabForBook` non-broadcaster was tested for maxDownloadSize — the broadcaster path and `postProcessSearchResults` both have independent debug-log branches that could regress. Each distinct entry point with its own behavior needs its own test.
