---
scope: [frontend, backend]
files: [src/client/hooks/useAuth.ts, src/client/App.test.tsx, src/client/components/layout/Layout.test.tsx]
issue: 8
date: 2026-03-19
---
Adding a required field to AuthState (e.g., `bypassActive: boolean`) causes TypeScript errors in every test file that mocks useAuthContext or useAuth — even files unrelated to the feature being implemented. For this issue: App.test.tsx, Layout.test.tsx, and useAuth.test.ts all needed `bypassActive: false` added. Enumerate blast-radius files up front during planning to avoid discover-them-one-at-a-time during verify.
