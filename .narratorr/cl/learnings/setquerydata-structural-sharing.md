---
scope: [frontend]
files: [src/client/pages/settings/BlacklistSettings.test.tsx]
issue: 555
date: 2026-04-14
---
`queryClient.setQueryData()` with structurally equivalent data may not trigger a component re-render due to React Query's structural sharing. To test effect-dep stability (verifying effects don't re-fire on re-render), use explicit `rerender()` calls instead of cache manipulation — it guarantees the component re-executes hooks.
