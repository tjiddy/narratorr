---
scope: [frontend]
files: [src/client/pages/library/useLibraryFilters.ts, src/client/hooks/usePagination.ts]
issue: 352
date: 2026-04-04
---
`usePagination` uses internal `useState` so page can't be initialized from URL params via constructor. A one-shot `useEffect` with a ref guard (`initializedRef`) is needed to call `pagination.setPage(initialPage)` on mount. Tests need `act(() => vi.advanceTimersByTime(0))` to flush this effect.
