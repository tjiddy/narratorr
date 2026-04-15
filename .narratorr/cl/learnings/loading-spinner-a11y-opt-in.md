---
scope: [frontend]
files: [src/client/components/icons.tsx, src/client/components/PageLoading.tsx, src/client/components/LazyRoute.tsx]
issue: 595
date: 2026-04-15
---
Shared icon components used in 30+ contexts (buttons, cards, page loading) must use opt-in a11y props, not blanket attributes. Adding `role="status"` to a shared spinner breaks semantics for decorative/inline usages. Pattern: optional `label` prop that conditionally renders ARIA attributes, with `aria-hidden="true"` as the default for decorative instances.
