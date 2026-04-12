---
scope: [frontend, backend]
files: [src/client/lib/api/books.ts, src/core/metadata/schemas.ts]
issue: 497
date: 2026-04-12
---
Client `BookMetadata` interface (`books.ts:75`) and server `BookMetadataSchema` (`schemas.ts:14`) are maintained independently — the client interface is hand-written, not derived from the Zod schema. Fields like `language` and `publishedDate` existed server-side but were missing client-side. When adding metadata fields, check both locations. This is a DRY-1 candidate for schema derivation.
