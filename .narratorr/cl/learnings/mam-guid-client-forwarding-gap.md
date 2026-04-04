---
scope: [core, frontend]
files: [src/core/indexers/myanonamouse.ts, src/client/components/SearchReleasesModal.tsx]
issue: 348
date: 2026-04-04
---
Adding a field to an indexer adapter is only half the fix if the client UI doesn't forward it. SearchReleasesModal.handleGrab() cherry-picks fields from the search result rather than spreading the whole object, so new SearchResult fields must be explicitly added to both the mutation call AND the PendingGrabParams type (for 409 replace-confirm replay). The spec review caught this — always trace the full data path from adapter → client → API → DB when adding fields.
