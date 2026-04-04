---
scope: [frontend, api]
files: [src/client/lib/api/indexers.ts, src/client/lib/api/api-contracts.test.ts]
issue: 339
source: review
date: 2026-04-04
---
When widening an API client function's type signature (e.g., adding optional `id` to `testIndexerConfig`), always add a contract test that verifies the new field is serialized into the request body. Component tests mock the API boundary, so they never exercise JSON serialization — a future refactor could silently drop the field without any test catching it.
