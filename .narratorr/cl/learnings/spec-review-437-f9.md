---
scope: [scope/backend, scope/core]
files: [src/server/services/metadata.service.ts, src/core/metadata/types.ts]
issue: 437
source: spec-review
date: 2026-03-18
---
Reviewer caught that the ISP interface split assigned methods to the wrong provider. I put getBook/getSeries/getAuthorBooks on MetadataLookupProvider (Audnexus), but MetadataService actually routes getBook() and getSeries() through withThrottle to providers[0] (Audible), and getAuthorBooks() is service-level orchestration (not a provider method at all). Root cause: designed the interface split based on method names and intuition ("lookup sounds like Audnexus") rather than reading the actual MetadataService call graph to see which methods are delegated to which provider field. Prevention: when splitting an interface by provider role, trace every call site in the consuming service first and map each method to the actual field it's called on (this.providers[0] vs this.audnexus). The split must match the call graph, not the method naming.
