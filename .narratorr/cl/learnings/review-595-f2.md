---
scope: [frontend]
files: [src/client/components/settings/useFetchCategories.test.ts]
issue: 595
source: review
date: 2026-04-15
---
`as ReturnType<typeof vi.fn>` only works for inline mock method access (e.g., `(api.method as ReturnType<typeof vi.fn>).mockResolvedValue(...)`) — not for satisfying typed function parameters. For mocks that must satisfy complex interface types (like `UseFormGetValues<T>`), use `as never` which is explicitly acceptable in tests per CLAUDE.md TS-2. The original AC was infeasible as written; `as never` eliminates both the double-cast and the imported form types.
