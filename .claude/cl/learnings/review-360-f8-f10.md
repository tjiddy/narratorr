---
scope: [backend, services]
files: [src/server/services/download-client.service.test.ts, src/server/services/indexer.service.test.ts, src/server/services/import-list.service.test.ts]
issue: 360
source: review
date: 2026-03-14
---
Round 2 reviewer caught that `isEncrypted()` is a necessary-but-not-sufficient assertion for sentinel preservation — it would pass even if the code encrypted the literal '********' string instead of preserving the stored ciphertext. The fix is asserting exact equality with the seeded encrypted value. Lesson: when testing value preservation through a transform pipeline, assert the exact output value, not just a property of it.
