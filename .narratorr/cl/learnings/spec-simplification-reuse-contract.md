---
scope: [backend]
files: [src/server/services/cover-download.ts, src/server/routes/books.ts]
issue: 369
date: 2026-04-06
---
When adding a feature that parallels an existing contract, always check if the existing contract can be reused instead of creating parallel fields/routes. The original spec for #369 proposed new `coverPath`/`imagePath` DB columns and `/api/images/*` routes, but the codebase already had `coverUrl` + `/api/books/:id/cover` for embedded covers. Reusing the existing contract eliminated: 2 DB columns, 2 new routes, frontend changes, and 242+ mock factory updates. The spec review caught this — but checking for reuse during elaboration would have saved 2 review rounds.
