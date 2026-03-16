---
scope: [type/chore, scope/infra]
files: []
issue: 329
source: spec-review
date: 2026-03-11
---
Round 1 refreshed the audit table but used inferred parent paths instead of copying them directly from `pnpm audit` output. The `rollup` advisory was attributed to Vite/Vitest paths but the actual primary path was `tsup > rollup`. The `ajv` advisory was attributed to `@fastify/helmet > helmet` but the actual paths were `fastify > @fastify/ajv-compiler > ajv` and `eslint > ajv`. For audit-driven specs, always regenerate the table by running `pnpm audit` and copying the exact parent paths from the output — don't reconstruct them from memory or assumption.
