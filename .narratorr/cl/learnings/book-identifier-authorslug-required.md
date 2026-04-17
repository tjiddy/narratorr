---
scope: [frontend]
files: [src/client/lib/api/books.ts, src/client/components/book/MetadataResultItem.test.tsx]
issue: 627
date: 2026-04-17
---
`BookIdentifier` requires `authorSlug: string | null` — test fixtures that create inline `BookIdentifier` objects for `isBookInLibrary()` assertions must include this field or TypeScript will reject the assignment. The `useBookIdentifiers` hook returns this shape from the API.
