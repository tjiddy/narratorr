---
scope: [scope/backend]
files: [src/server/routes/books.ts, src/server/services/book-rejection.service.ts, src/server/plugins/error-handler.ts]
issue: 274
source: review
date: 2026-04-01
---
**What was caught:** ERR-1 violation — the wrong-release route derived HTTP status codes by parsing error message strings (`error.message.includes('not found')`). Changing service error wording would silently turn expected client errors into 500s.

**Why we missed it:** The error-handler plugin's typed error registry pattern was not discovered during the Explore phase. The route was written with inline try/catch because that's what the original spec described. The architecture check for ERR-1 ("Does error handling branch on `message.includes('...')`?") was in the checklist but the pattern slipped through because the route was written before discovering the centralized error handler.

**What would have prevented it:** During `/plan` step 3, when adding a new route that needs HTTP error mapping, the Explore subagent should grep for the error-handler plugin pattern (`ERROR_REGISTRY`, `setErrorHandler`) and note the typed error class convention.
