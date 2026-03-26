---
scope: [frontend]
files: [src/client/components/DirectoryBrowserModal.tsx, src/client/components/DirectoryBrowserModal.test.tsx]
issue: 97
date: 2026-03-26
---
`parseBreadcrumbs` is synchronous and computed on mount from `currentPath` state, but tests still need `await screen.findByText()` for the first breadcrumb segment before synchronously asserting others. Even synchronously-set state values can require a rendering tick in the test environment when wrapped in `QueryClientProvider` + `MemoryRouter`. The pattern is: `await screen.findByText('firstSegment'); expect(screen.getByText('secondSegment')).toBeInTheDocument()`.
