---
scope: [frontend, backend]
files: [src/shared/indexer-registry.ts, src/client/components/settings/IndexerFields.test.tsx]
issue: 363
source: review
date: 2026-04-05
---
Reviewer caught that dropdown labels didn't match the spec's UI copy. The spec said "All, Active, Freeleech, Freeleech or VIP, VIP Only, Not VIP" but implementation used descriptive labels like "All torrents", "Only active (1+ seeders)". When a spec defines exact UI copy, use it verbatim — don't paraphrase. The test assertions then codified the wrong labels.
