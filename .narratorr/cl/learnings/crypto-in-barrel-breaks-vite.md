---
scope: [core]
files: [src/core/utils/index.ts, src/core/utils/download-url.ts]
issue: 527
date: 2026-04-13
---
Modules using `node:crypto` (like `download-url.ts`) cannot be re-exported from the `src/core/utils/index.ts` barrel — the barrel is imported by Vite client code, and `node:crypto` breaks the client build. Follow the same pattern as `collect-audio-files.js`: add a comment explaining why it's excluded and import directly from the module path.
