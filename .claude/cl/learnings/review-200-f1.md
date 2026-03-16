---
scope: [scope/backend]
files: [apps/narratorr/src/server/services/book.service.ts]
issue: 200
source: review
date: 2026-02-23
---
String `startsWith` for path ancestry checks is a security bug — `/library2/foo` matches `/library` as a prefix. Always use `path.relative()` and check the result doesn't start with `..` or resolve to an absolute path. This is a classic path traversal pattern that should be caught during implementation.
