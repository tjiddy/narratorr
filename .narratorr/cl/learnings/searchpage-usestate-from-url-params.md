---
scope: [frontend]
files: [src/client/pages/search/SearchPage.tsx]
issue: 322
date: 2026-04-03
---
When initializing React state from URL params, `useState(() => searchParams.get('q') ?? '')` works correctly because `useSearchParams` is available synchronously on first render (unlike `useLocation().search` which some guides warn about). For auto-triggering search, initialize `searchTerm` conditionally in the same `useState` call — no `useEffect` needed. This avoids REACT-4 (useEffect as event handler) and is simpler.