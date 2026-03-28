---
scope: [frontend]
files: [src/client/components/SearchReleasesModal.test.tsx]
issue: 63
date: 2026-03-24
---
TanStack Query's `mutationFn` mock captures a second argument `{ client, meta, mutationKey }` in tests when using `toHaveBeenLastCalledWith` — this causes strict argument-count mismatches. Use `vi.mocked(fn).mock.calls.at(-1)![0]` to extract the variables argument directly, then assert with `expect(args).toEqual(expect.objectContaining(...))`.
