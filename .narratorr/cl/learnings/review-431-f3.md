---
scope: [frontend]
files: [src/client/pages/book/BookDetails.test.tsx]
issue: 431
source: review
date: 2026-04-08
---
`expect.any(Number)` in API call assertions is vacuous — it proves the call happened with some number, but not the correct one. When testing that a component forwards an entity ID to an API call, render with a known concrete ID and assert that exact value. This is especially important for mutations where the wrong ID would affect the wrong entity.
