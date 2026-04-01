---
scope: [backend]
files: [src/server/services/download-client.service.test.ts]
issue: 263
source: review
date: 2026-04-01
---
Reviewer caught that the transaction test only asserted call count (`txInsert` called twice) without verifying the actual row payload. The test would pass even if the implementation used the wrong `downloadClientId` or swapped path fields. Root cause: the mock chain pattern (`mockDbChain`) makes it easy to assert call counts but the `.values()` payload requires explicit capture. Fix: override `.values()` on the mock chain for the second insert to capture and assert the payload. Lesson: when testing DB inserts via mocked chain, always assert the `.values()` arguments, not just the insert call count.
