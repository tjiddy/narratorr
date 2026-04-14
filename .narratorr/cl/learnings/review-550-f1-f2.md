---
scope: [frontend]
files: [src/client/App.tsx, src/client/components/LazyRoute.tsx]
issue: 550
source: review
date: 2026-04-14
---
Testing React.lazy Suspense/error behavior requires controlled lazy components (deferred promises, rejected imports). When internal wiring components like `LazyRoute` aren't exported, they can't be tested directly. Extract them to co-located files for testability. Also: `vi.mock` resolves synchronously in vitest, making it impossible to observe Suspense fallbacks through mocked modules — need `React.lazy(() => new Promise(...))` with manual resolve control.
