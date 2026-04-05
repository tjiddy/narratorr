---
scope: [frontend]
files: [src/client/components/settings/IndexerFields.tsx]
issue: 361
date: 2026-04-05
---
Extracting an API call payload into a local variable before passing it to a typed function can widen string literals (e.g., `type: 'myanonamouse'` becomes `string`). This caused a TS2345 error when `testIndexerConfig` expected `IndexerInput` with a narrow `type` union. Fix: keep the payload inline in the function call, or use `as const` on the literal field. Inline is simpler and matches the existing pattern in the codebase.
