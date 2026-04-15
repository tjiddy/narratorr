---
scope: [core]
files: [src/shared/schemas/indexer.ts, src/shared/normalize-base-url.ts]
issue: 560
source: review
date: 2026-04-15
---
When extracting a utility that will be consumed by `src/shared/` (schemas, registries), place it in `src/shared/` from the start — not in `src/core/utils/`. The project layering is shared→core→server/client. A `src/shared` import from `src/core` inverts the dependency direction. Generic string utilities (URL normalization, slug generation) belong in shared; domain-specific adapters belong in core.
