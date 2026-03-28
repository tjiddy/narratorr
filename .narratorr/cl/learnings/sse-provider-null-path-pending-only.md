---
scope: [frontend]
files: [src/client/components/SSEProvider.tsx, src/client/lib/api/auth.ts]
issue: 187
date: 2026-03-28
---
`SSEProvider` passes `authConfig?.apiKey ?? null` to `useEventSource`. The only `null` case is when `authConfig` is `undefined` (React Query still pending), not when it resolves with a null apiKey — `AuthConfig.apiKey` is typed as `string` (non-nullable). Writing a test step for "resolves with null apiKey" is incorrect; the right model is "auth config query still pending". Always check the actual type contract before writing test scenarios for null/falsy values.
