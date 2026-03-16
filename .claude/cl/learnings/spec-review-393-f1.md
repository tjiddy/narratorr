---
scope: [scope/backend]
files: [src/server/__tests__/helpers.ts]
issue: 393
source: spec-review
date: 2026-03-15
---
AC used "ALL Drizzle chainable query methods" which is not falsifiable — reviewer can't verify what "all" means. The real contract was behavioral (Proxy-based auto-generation with explicit exceptions for promise protocol). When writing ACs for open-ended/dynamic behavior, define the mechanism and its boundaries rather than listing every case.
