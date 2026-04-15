---
scope: [frontend]
files: [src/client/components/PageHeader.tsx, src/client/components/EmptyState.tsx, src/client/components/FilterPill.tsx, src/client/components/ErrorState.tsx]
issue: 582
date: 2026-04-15
---
When extracting shared components, always export the Props interface alongside the component. `TabItem` from `Tabs.tsx` is the established pattern. Omitting the export forces consumers to duplicate type definitions or use `ComponentProps<typeof X>` workarounds.
