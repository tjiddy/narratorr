---
scope: [frontend]
files: [src/client/lib/api/books.ts, src/client/pages/book/BookHero.tsx]
issue: 285
source: review
date: 2026-03-11
---
Backend added `importListName` to the book response via a LEFT JOIN, but the client type was not updated and no UI rendered the provenance tag. When a backend change adds a new field to an API response, always follow through to the client: update the TypeScript interface AND add the UI rendering. A backend-only change for a user-facing feature is incomplete.
