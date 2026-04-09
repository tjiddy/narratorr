---
scope: [backend]
files: [src/server/routes/refresh-scan.route.test.ts]
issue: 444
source: review
date: 2026-04-09
---
Route error tests must assert both HTTP status AND response body shape. When the spec defines exact error response bodies (`{ error: "..." }`), status-only assertions leave the contract unpinned — a regression that leaks raw error messages or returns wrong bodies would pass. Always `JSON.parse(res.payload)` and assert the full expected shape.
