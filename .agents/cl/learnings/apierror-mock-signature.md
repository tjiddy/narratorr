---
scope: [frontend]
files: [apps/narratorr/src/client/lib/api/client.ts]
issue: 168
date: 2026-02-23
---
When mocking `ApiError` in test files, the mock class constructor must match the real signature `(status: number, body: unknown)`, not the intuitive `(message: string, status: number)`. TypeScript resolves types from the real module, not the mock. The real ApiError extracts the message from `body.error` internally.
