---
scope: [scope/frontend]
files: [src/client/hooks/useLibrary.ts, src/client/components/manual-import/BookEditModal.tsx, src/client/pages/author/AuthorPage.tsx]
issue: 372
source: review
date: 2026-03-16
---
When adding server-side default limits to an API that previously returned all data, check ALL callers of the hook/API client — not just the primary page. `useLibrary()` was called by BookEditModal and AuthorPage for duplicate detection, and adding a default limit=100 silently broke those flows for large libraries. The blast radius section in the spec listed affected files but didn't flag this specific regression path.
