---
scope: [frontend]
files: [src/client/components/settings/SelectWithChevron.tsx]
issue: 288
date: 2026-04-01
---
When adding a variant prop to a shared component where callers need different sizing, design the variant as a shared base that omits the conflicting Tailwind utilities (e.g., `py-*`, `text-*`), and let callers pass the caller-specific classes via `className`. This avoids Tailwind class conflicts (later class in the class string doesn't reliably override earlier ones without `tailwind-merge`). The spec review caught this — a single fixed "compact" preset can't serve two callers with different padding/font-size needs.
