---
scope: [frontend]
files: [src/client/lib/api/books.ts, src/client/lib/api/api-contracts.test.ts]
issue: 445
source: review
date: 2026-04-09
---
Reviewer caught that `uploadBookCover` bypasses `fetchApi` (uses raw `fetch` + `FormData`) but had no contract test in `api-contracts.test.ts`. The existing `uploadRestore` in `backups.ts` follows the same raw-fetch pattern and also lacks a contract test — this is a pre-existing gap. When adding API methods that bypass `fetchApi`, always add a contract test in `api-contracts.test.ts` covering URL, method, credentials, body type, and error parsing. Also need to add `URL_BASE: ''` to the client.js mock since raw-fetch methods import it directly.
