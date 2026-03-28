---
scope: [scope/infra]
files: [scripts/lib.ts]
issue: 412
date: 2026-03-16
---
Node 22 strip-only TypeScript mode does not support parameter properties (`public readonly` in constructor params). Must use explicit class field assignment instead. This applies to all scripts/ files which run via Node directly (not through Vite/vitest which use full TS transforms). Caught at verify.ts runtime, not at typecheck.
