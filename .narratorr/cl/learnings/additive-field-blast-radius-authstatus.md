---
scope: [frontend, backend]
files: [src/client/lib/api/auth.ts, src/client/hooks/useAuth.test.ts, src/client/pages/settings/SecuritySettings.test.tsx]
issue: 17
date: 2026-03-20
---
Adding a required field to `AuthStatus` (the `/api/auth/status` response shape) cascades to all test files that inline mock the full `AuthStatus` object via `api.getAuthStatus`. These include `useAuth.test.ts` (~8 occurrences) and `SecuritySettings.test.tsx` (~7 occurrences). TypeScript won't catch missing fields at runtime — tests pass silently. The fixture blast radius section in the spec correctly enumerated these files; consult it before implementing to batch all inline mock updates in one step.
