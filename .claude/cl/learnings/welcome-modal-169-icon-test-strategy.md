---
scope: [frontend]
files: [src/client/components/WelcomeModal.tsx, src/client/components/WelcomeModal.test.tsx]
issue: 169
date: 2026-03-28
---
Custom SVG icon components in `src/client/components/icons.tsx` do NOT use Lucide class names (no `lucide-headphones` class) — they render plain SVGs with only the passed `className`. To test icon swaps: add `data-testid` to the icon wrapper container and assert the SVG's `stroke-width` attribute (different icons use different stroke widths — `HeadphonesIcon` uses `1.5`, `BookOpenIcon` uses `2`). This is more stable than asserting SVG path data.
