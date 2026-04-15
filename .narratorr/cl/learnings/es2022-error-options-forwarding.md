---
scope: [core]
files: [src/core/download-clients/errors.ts, src/core/download-clients/retry.ts]
issue: 593
date: 2026-04-15
---
ES2022 `ErrorOptions` with `{ cause }` requires forwarding through the entire class hierarchy — each constructor must accept and pass `options` to `super()`. The base `Error` constructor handles `.cause` assignment, but custom subclass chains (e.g., `DownloadClientTimeoutError → DownloadClientError → Error`) each need the parameter added explicitly. TypeScript's built-in `ErrorOptions` type from `lib.es2022.error.d.ts` is the canonical type to use.
