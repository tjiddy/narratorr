---
scope: [backend]
files: [src/server/services/discovery-signals.ts]
issue: 196
date: 2026-03-29
---
When generating positions on a floating-point grid (base + n*step), rounding must be relative to the base position, not zero. `Math.round(i / step) * step` snaps to a zero-origin grid which is wrong when the base is fractional (e.g., 1.5). Use `base + Math.round((i - base) / step) * step` instead. This caused the first implementation attempt to produce integer gaps [3, 4] instead of fractional gaps [3.5] for series starting at 1.5.
