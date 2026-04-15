---
scope: [frontend]
files: [src/client/components/settings/useFetchCategories.ts]
issue: 562
date: 2026-04-15
---
Testing a useEffect reset branch in a custom hook requires renderHook with rerender — first populate state via the hook's own methods (e.g., fetchCategories), then rerender with changed props to trigger the effect. The key insight: caller-level tests (DownloadClientFields.test.tsx) can cover fetch behavior but miss dependency-array effects that only fire on prop changes, because the caller's test wrapper doesn't typically change the prop driving the effect.
