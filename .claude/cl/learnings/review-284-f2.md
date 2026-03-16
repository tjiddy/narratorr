---
scope: [backend]
files: [src/server/server-utils.ts, src/server/server-utils.test.ts]
issue: 284
source: review
date: 2026-03-10
---
Server utility functions that depend on filesystem state (like registerStaticAndSpa reading index.html) need a `clientPathOverride` parameter for testability. The original implementation hardcoded `__dirname` relative paths, making it impossible to test without mocking fs. Adding a test-only parameter and using a temp directory with a minimal index.html makes the tests straightforward and reliable.
