---
scope: [backend]
files: [src/server/services/search-pipeline.ts, src/server/services/search-pipeline.test.ts]
issue: 30
source: review
date: 2026-03-20
---
When a production regex implements a multi-variant contract (e.g., M4B|MP3|FLAC|AAC|OGG), tests must cover every variant in the alternation — not just a sampling. A test that only checks M4B/MP3/AAC would not catch removing FLAC or OGG from the regex. Rule: one test assertion per variant when the contract is a closed enum. Prevented by: spec/test plan explicitly listing all variants with direct test cases.
