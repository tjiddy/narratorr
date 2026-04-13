---
scope: [backend]
files: [src/server/services/search-pipeline.ts, src/server/jobs/rss.ts]
issue: 520
date: 2026-04-13
---
`nzbName` is only populated by `enrichUsenetLanguages()` — any filter that runs before enrichment cannot use nzbName. In `postProcessSearchResults()`, multi-part filtering (line 290) runs before enrichment (line 306), and in `rss.ts`, multi-part filtering (line 96) runs before enrichment (line 150). Only `filterAndRankResults()` (called after enrichment) can reliably read nzbName. This ordering constraint was the root cause of 3 spec review rounds — checking enrichment timing should be the first validation step for any nzbName-dependent change.
