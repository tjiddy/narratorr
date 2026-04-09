---
scope: [backend]
files: [src/server/routes/library-scan.ts]
issue: 446
source: review
date: 2026-04-09
---
Wrapping both an external API call (metadata search) and a local DB call (findDuplicate) in the same try/catch with a 502 response misclassifies database failures as upstream provider errors. Always separate error domains: 502 for upstream provider failures, 500 for local/database failures. Each should have its own try/catch with appropriate status code and message.
