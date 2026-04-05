---
scope: [backend, frontend]
files: [src/core/indexers/registry.test.ts, src/client/components/settings/IndexerFields.test.tsx]
issue: 363
date: 2026-04-05
---
Helper functions defined inside a `describe()` block (like `captureSearchUrl`, `MamFieldWrapper`) are not accessible from sibling `describe()` blocks. When adding new test sections that need the same helper, either duplicate the helper in the new block or hoist it to the parent scope. This caused `ReferenceError: captureSearchUrl is not defined` during initial test runs.
