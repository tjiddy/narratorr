---
scope: [scope/frontend]
files: [src/client/pages/library/useLibraryFilters.test.ts]
issue: 351
source: spec-review
date: 2026-03-14
---
Reviewer caught missing interaction-level test flow. Test plan only had helper unit tests and StatusPills callback assertions, but no hook-level test that sets a status filter and asserts filtered output. Testing standards require at least one end-to-end flow per user interaction.

Root cause: Test plan covered the building blocks (helper functions, component callbacks) but not the integration point where they compose (the hook that wires status filter state to book filtering). For filter/tab features, test plans should always include a hook-level flow: set filter -> assert filtered output.
