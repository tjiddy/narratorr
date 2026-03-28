---
scope: [frontend]
files: [apps/narratorr/src/client/components/AuthContext.ts, apps/narratorr/src/client/components/AuthProvider.tsx]
issue: 168
date: 2026-02-23
---
Exporting both a React component AND a `createContext()` object from the same file triggers the Vite fast-refresh lint rule. The fix is to put the context + its type in a separate file (e.g., `AuthContext.ts`) and import it in the provider component. This is a common pattern for any Provider component.
