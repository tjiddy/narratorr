---
scope: [core]
files: [src/core/indexers/myanonamouse.ts]
issue: 372
date: 2026-04-06
---
Adding a `classname` property to the adapter class and setting it in the constructor triggered a TS6133 "declared but never read" error because `search()` only reads `this.isVip`, not `this.classname`. The adapter doesn't need to store classname internally — it's metadata for the service layer to persist to DB. Only store adapter properties that the adapter itself reads; return metadata to the caller instead.
