---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.test.tsx]
issue: 183
date: 2026-03-29
---
localStorage persists between tests in jsdom. When earlier tests switch to table view and save to localStorage, later tests that assume grid mode (e.g., card menu tests) fail because the component reads localStorage on mount. Always add `localStorage.removeItem('narratorr:library-view')` in `beforeEach` for any describe block that depends on the default view mode.
