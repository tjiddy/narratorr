---
scope: [frontend]
files: [src/client/pages/activity/ActivityPage.test.tsx]
issue: 414
date: 2026-04-08
---
`setQueryData` updates the cache synchronously, but with `staleTime: 0` (default), TanStack Query considers the data immediately stale and fires a background refetch when a component subscribes to that key. In tests that simulate data changes via `setQueryData`, the mock's return value can race with and overwrite the manually set data. Use `staleTime: Infinity` in test QueryClients where `setQueryData` must be authoritative.
