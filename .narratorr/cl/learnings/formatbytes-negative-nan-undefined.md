---
scope: [frontend]
files: [src/client/lib/api/utils.ts, src/client/components/SearchReleasesModal.tsx]
issue: 29
date: 2026-03-20
---
`Math.log(negative)` returns `NaN`, making `Math.floor(NaN)` = `NaN`, and `sizes[NaN]` = `undefined` — producing "NaN undefined" output. Guard with `bytes < 0` before any math. Similarly, `Math.log(Infinity)` = `Infinity`, causing `sizes[Infinity]` = `undefined`. Add `!isFinite(bytes)` alongside the negative guard, plus a post-computation `i >= sizes.length` safety net for huge-but-finite inputs. The existing `!bytes` guard already handles `NaN`, `0`, and `undefined` — the real gap is valid-looking truthy values that break the math.
