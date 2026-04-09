---
scope: [frontend]
files: [src/client/lib/eventReasonFormatters.tsx, src/client/lib/eventReasonFormatters.test.tsx]
issue: 455
source: review
date: 2026-04-09
---
Reviewer caught that `upgraded` dispatch branch in DETAIL_RENDERERS had no test. Even though it reuses `ImportedDetails` (same as `imported`), the dispatch entry itself is a separate code branch. When adding entries to a renderer/dispatch map, each entry needs its own test proving the dispatch works — reusing the same underlying component doesn't exempt it. The test should assert the entry-specific labels appear (not generic fallback labels), proving the dispatch is wired correctly.
