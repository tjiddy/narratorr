---
scope: [core]
files: [src/core/utils/language-codes.ts, src/shared/indexer-registry.ts]
issue: 668
date: 2026-04-22
---
When a utility needs a mapping that already exists elsewhere in the codebase (e.g. MAM id→name in `MAM_LANGUAGES`), build the reverse lookup once at module load from the canonical source rather than duplicating the data. `new Map(MAM_LANGUAGES.map(l => [String(l.id), l.label.toLowerCase()]))` keeps `normalizeLanguage` in sync with the UI registry automatically — a new MAM id added to the shared registry is picked up without touching the utility. Drive table-style unit tests from the same registry (`it.each(MAM_LANGUAGES.map(...))`) so the test coverage tracks the source of truth too.
