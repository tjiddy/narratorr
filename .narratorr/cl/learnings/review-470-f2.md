---
scope: [backend]
files: [src/server/services/library-scan.service.test.ts, src/server/services/enrichment-orchestration.helper.ts]
issue: 470
source: review
date: 2026-04-11
---
Reviewer caught that newly extracted builder helpers (`buildEnrichmentBookInput`, `extractImportMetadata`) had no tests asserting non-null value passthrough. The existing service tests only exercised the all-null case. When extracting inline object construction into helper functions, always add tests for the non-null path — the happy path through the builder is the one most likely to regress silently if the builder drops a field.
