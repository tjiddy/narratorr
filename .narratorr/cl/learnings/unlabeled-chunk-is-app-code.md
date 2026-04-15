---
scope: [frontend]
files: [src/client/lib/manual-chunks.ts]
issue: 584
date: 2026-04-15
---
The large unlabeled shared chunk in Vite builds (~163 kB) is Rollup's automatic code-splitting of application code shared across multiple lazy-loaded routes — not mystery vendor code. Investigating build artifacts by reading the chunk's imports (it imports from `vendor-react` and `index` entry, and contains app-level components like settings presets) confirms it. Future chunking issues should check whether unlabeled chunks are app-code splits before trying to assign them to vendor groups.
