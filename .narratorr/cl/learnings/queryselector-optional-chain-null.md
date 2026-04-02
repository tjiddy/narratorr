---
scope: [frontend]
files: [src/client/pages/search/SearchTabContent.test.tsx]
issue: 296
date: 2026-04-02
---
`document.querySelector(...)?.closest(...)` returns `undefined` (not `null`) when the initial querySelector returns null. Tests using `toBeNull()` will fail because `undefined !== null`. Always add `?? null` at the end of optional-chained DOM queries used in test helpers: `querySelector(...)?.closest(...) ?? null`.
