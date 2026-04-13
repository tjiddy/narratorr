---
scope: [frontend]
files: [src/client/components/EventHistoryCard.tsx]
issue: 537
date: 2026-04-13
---
Adding a single conditional button (`canRetry && onRetry`) to `EventHistoryCard` pushed cyclomatic complexity from 15 to 19 (limit 15). The fix was extracting `EventCardActions` as a sibling component. When a component is already at the complexity limit (has an eslint suppression or is at exactly 15), plan extraction upfront before adding new conditional branches — discovering it post-implementation means an extra verify cycle.
