---
scope: [backend]
files: [src/server/jobs/rss.test.ts]
issue: 532
source: review
date: 2026-04-13
---
Reviewer caught that the blacklist-before-enrichment test only proved one half of the enrichment scope invariant: blacklisted items don't reach enrichment. The other half — unmatched below-threshold items also don't reach enrichment — was untested. When a spec AC says "enrichment scope remains X only," each exclusion path needs its own test: blacklisted items excluded, unmatched items excluded. The implementation was correct but the test coverage had a gap.
