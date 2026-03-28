---
scope: [backend, frontend, core]
files: [src/server/__tests__/search-grab-flow.e2e.test.ts]
issue: 188
date: 2026-03-28
---
For annotation-only sweeps (catch(error) → catch(error: unknown) with strict mode already active), existing tests provide sufficient behavioral coverage — no new tests needed for the annotations themselves. But any behavioral fix bundled in the sweep (like a guard change) still requires a red/green test cycle. The null-throw case produced a genuinely failing test because the broken code returned Fastify's `{ error: 'Internal Server Error' }` while the fixed code returns the route's `{ error: 'Unknown error' }` — asserting the specific body discriminates between the two paths.
