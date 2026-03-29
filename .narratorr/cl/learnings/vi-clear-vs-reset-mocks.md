---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.test.tsx]
issue: 183
date: 2026-03-29
---
`vi.clearAllMocks()` only clears call history, instances, and results — it does NOT reset `mockImplementation`. When tests in the same file use different mock implementations (e.g., `mockLibraryData` vs `mockPagedLibraryData`), each test must explicitly call its own mock setup to overwrite the previous one. If you rely on `clearAllMocks` to reset implementations between tests, localStorage or API state from prior tests can leak and cause order-dependent failures.
