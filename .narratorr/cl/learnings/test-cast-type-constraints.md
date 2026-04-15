---
scope: [frontend]
files: [src/client/components/settings/useFetchCategories.test.ts]
issue: 595
date: 2026-04-15
---
`as ReturnType<typeof vi.fn>` casts only work for inline method access on already-stored mocks, not for mock declarations that must satisfy typed function parameters. When a mock feeds into a typed interface (e.g., `UseFormGetValues<T>`), the `as unknown as InterfaceType` double-cast is unavoidable — move it to the consumption site rather than the declaration for cleaner mock setup.
