---
scope: [frontend, backend]
files: [src/client/lib/api/utils.ts, src/server/services/search-pipeline.ts]
issue: 29
date: 2026-03-20
---
JSON transport coerces `NaN` and `Infinity` to `null` — these values cannot arrive at the client from a JSON API response. Spec/test work for Infinity and Number.MAX_VALUE paths is defense-in-depth only; the reproducible bug is negative values (e.g., -1 as a sentinel) which DO survive JSON transport. When scoping defensive formatter fixes, always verify which invalid inputs can actually arrive via the transport layer to avoid scope creep on unreachable paths.
