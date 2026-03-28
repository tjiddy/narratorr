---
scope: [backend]
files: [src/server/services/discovery.service.test.ts]
issue: 407
date: 2026-03-17
---
When testing diversity candidates via generateCandidates(), the mock for searchBooksForDiscovery must distinguish between affinity queries (author name, genre keyword) and diversity queries (curated genre keywords). A blanket mock returning the same book for all queries lets affinity queries claim the ASIN first, making diversity tests fail. Use mockImplementation with query-string matching to isolate affinity vs diversity results.
