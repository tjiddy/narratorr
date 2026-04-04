---
scope: [frontend]
files: [src/client/pages/library/useLibraryFilters.test.tsx]
issue: 352
date: 2026-04-04
---
React lint rules forbid mutating module-level variables during render (even in test-only components). To capture URL state from a test helper component, assign inside `useEffect` not during render. Pattern: `const urlRef = { current: '' }; function UrlCapture() { useEffect(() => { urlRef.current = value; }); }`.
