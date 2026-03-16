---
scope: [backend]
files: [src/server/utils/book-status.test.ts]
issue: 350
source: review
date: 2026-03-14
---
When testing a utility that performs a DB write, asserting only the return value is insufficient — the test must also assert the DB write contract (`.set()` payload and `.where()` target). A helper could return the right string while writing the wrong status to the wrong row. Use `mockDbChain` and capture `.set()` / `.where()` mock arguments to verify the full persistence contract.
