---
scope: [core, backend]
files: [src/core/utils/index.ts, src/core/utils/collect-audio-files.ts]
issue: 405
date: 2026-04-07
---
Files in `src/core/utils/` that import `node:fs/promises` cannot be barrel-exported from `index.ts` — the Vite client build bundles everything reachable from the barrel, and Node.js built-ins fail Rollup's externalization. Import these modules directly instead of through the barrel. This wasn't documented and cost a full verify cycle to discover.
