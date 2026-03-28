---
scope: [scope/backend, scope/core]
files: [src/core/metadata/types.ts, src/server/services/metadata.service.ts]
issue: 437
date: 2026-03-18
---
When splitting a fat interface by provider role, the split must follow the actual call graph in the consuming service, not method naming intuition. MetadataService routes getBook/getSeries through withThrottle to providers[0] (search provider) and only calls getBook/getAuthor on the audnexus field (enrichment). Naming the interfaces "search" vs "lookup" led to wrong method assignments — the correct split came from tracing which field each method is invoked on.
