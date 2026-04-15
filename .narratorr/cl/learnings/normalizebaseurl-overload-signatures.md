---
scope: [core]
files: [src/core/utils/normalize-base-url.ts]
issue: 560
date: 2026-04-15
---
When extracting a URL normalization helper that must handle both `string` and `undefined` inputs (for optional config fields like `flareSolverrUrl`), TypeScript overload signatures (`normalizeBaseUrl(url: string): string` + `normalizeBaseUrl(url: undefined): undefined`) provide better ergonomics than a single `string | undefined` return type — callers don't need to re-narrow the result.
