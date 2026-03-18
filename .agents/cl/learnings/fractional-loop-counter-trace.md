---
scope: [backend]
files: [src/server/services/discovery-signals.ts]
issue: 404
date: 2026-03-17
---
`computeSeriesGaps()` uses `for (let i = Math.min(...sorted); i <= maxOwned; i++)` — when positions are fractional (e.g., [1.5, 2.5]), the loop starts at 1.5 and increments by 1, visiting 1.5, 2.5. It NEVER lands on integer values, so `Number.isInteger(i)` never triggers gap detection. Only the continuation `maxOwned + 1` is produced. This caused 3 rounds of spec review ping-pong because each fix copied the wrong worked example forward without tracing the actual loop variable values step by step.
