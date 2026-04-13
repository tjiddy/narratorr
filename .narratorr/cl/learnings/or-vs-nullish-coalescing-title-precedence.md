---
scope: [backend]
files: [src/server/services/search-pipeline.ts]
issue: 533
date: 2026-04-13
---
The search pipeline had inconsistent title precedence operators: `filterAndRankResults` used `||` (lines 188, 197, 209) but the multi-part filter used `??` (line 294). The difference matters because `||` skips empty strings while `??` does not. When nzbName is `""` (empty from a failed NZB parse), `??` would use the empty string instead of falling through to rawTitle. Always use `||` for title precedence chains where empty string should be treated as absent.
