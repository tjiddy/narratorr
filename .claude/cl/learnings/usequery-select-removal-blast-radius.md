---
scope: [frontend]
files: [src/client/hooks/useLibrary.ts, src/client/components/manual-import/BookEditModal.tsx, src/client/pages/author/AuthorPage.tsx]
issue: 372
date: 2026-03-15
---
Removing `.select(response => response.data)` from a TanStack Query hook changes the return type for ALL callers. When `useLibrary` stopped unwrapping the envelope, `BookEditModal` and `AuthorPage` broke because they expected `data` to be `BookWithAuthor[]` but got `{ data: BookWithAuthor[]; total: number }`. Always grep for all callers of a hook before changing its return type. The fix was `const books = libraryResponse?.data` at each call site.
