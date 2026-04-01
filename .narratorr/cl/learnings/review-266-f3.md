---
scope: [backend]
files: [src/server/services/book-list.service.test.ts]
issue: 266
source: review
date: 2026-04-01
---
Backend ORDER BY tests that only assert argument count are insufficient — they pass even if clauses are in wrong order or wrong direction. Drizzle SQL objects expose `queryChunks` with StringChunk objects (`.value` array) that can be inspected for direction strings ("asc"/"desc") and column name references. Use these to assert semantic correctness: clause direction, conditional column references, and ordering invariants.
