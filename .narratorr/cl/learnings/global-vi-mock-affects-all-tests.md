---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.test.tsx]
issue: 183
date: 2026-03-29
---
`vi.mock()` is hoisted and applies to the ENTIRE test file — you cannot scope it to a describe block. Mocking `DEFAULT_LIMITS.books` from 100 to 3 globally broke 50+ existing tests because pagination suddenly rendered everywhere. For test-file-scoped constants like page limits, either use the real value and create enough mock data, or provide a test-specific helper that controls the mock return (like `mockPagedLibraryData` with independent `total`).
