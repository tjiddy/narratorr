---
scope: [frontend]
files: [src/client/components/EmptyState.tsx, src/client/pages/discover/DiscoverEmpty.tsx, src/client/pages/library/EmptyLibraryState.tsx]
issue: 582
date: 2026-04-15
---
When a shared component's children slot is used exclusively for CTA action rows, the layout (`flex flex-wrap items-center gap-3`) belongs in the shared component, not duplicated in each consumer. Conditional rendering with `{children && <div>...{children}</div>}` avoids an empty wrapper when no children are provided.
