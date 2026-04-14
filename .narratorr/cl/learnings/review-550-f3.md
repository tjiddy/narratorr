---
scope: [frontend]
files: [vite.config.ts, src/client/lib/manual-chunks.ts]
issue: 550
source: review
date: 2026-04-14
---
Build config functions (like Vite `manualChunks`) should be extracted to testable modules, not inlined in config files. A successful `pnpm build` doesn't prove the chunking contract — it just proves the build didn't crash. Extract the function and assert representative module IDs map to expected chunk names.
