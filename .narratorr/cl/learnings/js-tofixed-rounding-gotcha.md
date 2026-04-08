---
scope: [backend]
files: [src/server/services/match-job.service.ts]
issue: 415
date: 2026-04-08
---
JavaScript's `toFixed(1)` on 37.15 returns "37.1" (not "37.2") due to IEEE 754 floating-point representation. When writing tests that assert formatted decimal values, always compute the expected value in a Node REPL first rather than calculating by hand — the spec's example of "2229 min → 37.2 hrs" was wrong because `(2229/60).toFixed(1)` is "37.1".
