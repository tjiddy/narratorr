---
scope: [backend, services]
files: [src/server/services/book.service.ts]
issue: 246
date: 2026-03-31
---
When modifying a shared service method (like `findDuplicate()`), the spec must explicitly state whether the behavior change applies to all callers or is scoped to the new feature. The spec review caught this as a blocking finding — title-only dedup affected library-scan and discovery callers too. Spec round-trips could have been avoided by grepping all callers during elaboration and declaring the shared behavior upfront.
