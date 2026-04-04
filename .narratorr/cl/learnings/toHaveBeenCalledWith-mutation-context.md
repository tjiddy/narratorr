---
scope: [frontend]
files: [src/client/components/SearchReleasesModal.test.tsx]
issue: 348
date: 2026-04-04
---
TanStack Query's `useMutation` calls the `mutationFn` with TWO arguments (variables + mutation context), not one. Using `toHaveBeenCalledWith(expect.objectContaining({...}))` fails because it expects exactly one argument. Use `mock.calls[0][0]` to access the first argument directly, then assert against that.
