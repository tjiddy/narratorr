---
scope: [backend]
files: [src/server/routes/books.ts]
issue: 282
date: 2026-03-10
---
Adding a new route to `booksRoutes()` pushed it past `max-lines-per-function` (151 vs 150). Extracting route registration into standalone functions (e.g., `registerBookSearchRoute()`) keeps the main wiring function lean. The delete route had already been extracted for the same reason — follow that pattern for any new routes.
