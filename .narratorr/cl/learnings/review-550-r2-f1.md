---
scope: [frontend]
files: [src/client/components/LazyRoute.tsx, src/client/components/RouteErrorBoundary.tsx]
issue: 550
source: review
date: 2026-04-14
---
Class-based React error boundaries retain `hasError` state across route navigations because React reconciles the same component type. When `<LazyRoute>` wraps routes, navigating from a failed route to a working one doesn't reset the error boundary. Fix: use `key={pathname}` on the error boundary so React mounts a fresh instance on each navigation. This also means "sibling stays mounted" tests are insufficient — must test actual route navigation after failure to prove the user can recover.
