---
scope: [backend]
files: [src/server/services/search-pipeline.ts]
issue: 386
source: review
date: 2026-04-07
---
When spec says "first entry used as primary for sort ranking," the comparator needs an explicit sub-tier — simple `includes()` membership treats all matches equally. The gap: we implemented any-of matching but missed the primary-language preference within matches. Read spec assertions literally and translate each ranking claim into a comparator tier.
