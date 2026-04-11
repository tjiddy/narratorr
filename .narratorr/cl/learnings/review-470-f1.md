---
scope: [backend]
files: [src/server/services/library-scan.service.ts, src/server/services/enrichment-orchestration.helper.ts]
issue: 470
source: review
date: 2026-04-11
---
Reviewer caught that the two lazy complexity suppressions targeted for removal (enrichImportedBook, processOneImport) were retained despite the enrichment extraction. Root cause: the initial extraction moved the enrichment orchestration calls but left nullable coalescing operators (`??`, `||`) inline in event payloads and config objects, which ESLint counts as branches. Fix: extract event payload builders and config builders as standalone functions to move the branches out of the methods. Lesson: when the goal is to reduce cyclomatic complexity below a threshold, count ALL branch operators in the target function (including `??`, `||`, ternaries) — not just the "real" if/else logic.
