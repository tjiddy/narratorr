---
scope: [frontend]
files: [src/client/pages/discover/DiscoverPage.tsx, src/client/lib/helpers.ts]
issue: 524
date: 2026-04-13
---
When building a CreateBookPayload from a non-BookMetadata source (like SuggestionRowResponse), do not reuse `mapBookMetadataToPayload` — it is typed for BookMetadata and omits fields like `publishedDate`. Build the payload inline from the source type's fields. This was caught during spec review (round 2) after an incorrect claim that the helper included `publishedDate`.
