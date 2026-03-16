---
scope: [scope/backend]
files: [src/server/__tests__/helpers.ts, src/server/services/book.service.test.ts]
issue: 393
source: spec-review
date: 2026-03-15
---
Test plan included rejection-path test cases (`.catch()`, `.finally()`) but the spec never defined how to configure a rejected chain. The elaboration skill added test scenarios from source analysis without ensuring the spec had matching ACs for the test configuration API. When adding error-path test cases, always check that the spec defines the API for triggering those error paths.
