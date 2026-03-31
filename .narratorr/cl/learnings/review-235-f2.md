---
scope: [backend]
files: [src/server/services/match-job.service.ts]
issue: 235
source: review
date: 2026-03-31
---
When the spec says duration "still factors into confidence," that means it affects the confidence *level* of the similarity-ranked winner — not that it can override the winner itself. The original `disambiguateByDuration()` re-sorted by duration distance, which threw away the similarity ranking. The correct approach: keep the similarity winner as bestMatch, and only use that winner's duration distance to determine confidence (high vs medium). Duration is a verification signal, not a selection signal.
