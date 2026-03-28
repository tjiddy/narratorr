---
scope: [frontend]
files: [src/client/components/manual-import/ImportCard.tsx, src/client/components/manual-import/types.ts]
issue: 143
date: 2026-03-26
---
After moving an inline type definition (e.g., ImportRow) to a separate types.ts, the original file may still import symbols that were only needed for the old inline definition. In ImportCard.tsx, DiscoveredBook and MatchResult were previously needed to define ImportRow inline; after the move, only Confidence remained needed. ESLint @typescript-eslint/no-unused-vars catches these stale imports — watch for them on the first verify run after a type migration.
