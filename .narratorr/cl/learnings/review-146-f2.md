---
scope: [frontend]
files: [src/client/pages/library/LibraryBookCard.test.tsx]
issue: 146
source: review
date: 2026-03-26
---
React.memo effectiveness tests must be falsifiable: checking DOM content count or node identity after rerender is NOT falsifiable because React reconciles to the same DOM even on full re-renders. The correct pattern: spy on a hook that's called every time the component body executes (e.g., `vi.spyOn(ImageErrorModule, 'useImageError')`), count calls after mount, rerender with the same stable prop references, and assert call count is unchanged. Removing memo would cause the body to re-execute, increasing the spy count and failing the test. Also, fresh `vi.fn()` props on rerender defeats memo — use the same callback instances for both renders.
