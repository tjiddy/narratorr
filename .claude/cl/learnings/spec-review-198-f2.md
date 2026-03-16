---
scope: [scope/backend]
files: []
issue: 198
source: spec-review
date: 2026-03-12
---
Spec said "after import + conversion" but the import pipeline has 10+ phases after audio conversion (rename, enrichment, tag embedding, notifications, event history, torrent removal). Vague placement like "after processing" is not testable when the pipeline is order-sensitive. Specs adding new import pipeline phases must specify exact ordering relative to existing phases with line references to `import.service.ts`.
