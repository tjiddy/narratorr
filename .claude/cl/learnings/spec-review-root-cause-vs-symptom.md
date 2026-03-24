---
scope: [frontend, backend]
files: [src/server/server-utils.ts]
issue: 10
date: 2026-03-19
---
The first two rounds of spec review were needed because the initial fix proposal (change `vite.config.ts` `base: '/'`) targeted a symptom (relative paths in HTML) without understanding root cause (relative paths are intentional; the SPA fallback was serving them as HTML). When a spec proposes fixing X by changing Y, always verify that Y is the actual root cause and not a side-effect. Reading the learning doc `vite-base-buildtime-vs-runtime.md` earlier would have prevented both wrong fix proposals.
