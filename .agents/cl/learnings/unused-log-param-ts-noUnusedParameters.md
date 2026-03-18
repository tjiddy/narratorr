---
scope: [scope/services, scope/backend]
files: [src/server/services/book-list.service.ts]
issue: 397
date: 2026-03-16
---
With `noUnusedParameters: true` in tsconfig, don't add constructor params "for consistency" if the service doesn't use them yet. BookListService initially included a `log: FastifyBaseLogger` param to match other services, but TS flagged it as unused. Removing it was cleaner than prefixing with underscore. If logging is needed later, add it then.
