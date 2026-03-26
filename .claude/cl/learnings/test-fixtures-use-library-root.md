---
scope: [frontend]
files: [src/client/pages/manual-import/ManualImportPage.test.tsx]
issue: 134
date: 2026-03-26
---
Pre-existing tests that use the library root path as a favorite/recent folder will break when a guardrail is added that blocks scanning library-root paths. The `beforeEach` in ManualImportPage.test.tsx sets mockGetSettings to return library path `/audiobooks`. Two tests used `mockFavorites = [{ path: '/audiobooks', ... }]` — clicking that favorite now correctly triggers the guardrail and blocks the scan. Update those tests to use a path that is clearly outside the library root (e.g., `/media/audiobooks` or `/media`).
