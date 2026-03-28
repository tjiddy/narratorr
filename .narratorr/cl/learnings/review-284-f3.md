---
scope: [frontend]
files: [src/client/lib/api/client.ts, src/client/lib/api/client.test.ts]
issue: 284
source: review
date: 2026-03-10
---
Module-level constants like `URL_BASE` require `vi.resetModules()` + dynamic `import()` to test with different values. The existing tests only asserted root-path API calls (`/api/books`), which would still pass even if the URL_BASE wiring was broken. Always test the non-default configuration path — if a feature only activates with a specific env var, at least one test must set that env var.
