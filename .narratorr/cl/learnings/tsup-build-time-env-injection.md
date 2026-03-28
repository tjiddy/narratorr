---
scope: [backend, infra]
files: [tsup.config.ts, src/server/utils/version.ts]
issue: 37
date: 2026-03-20
---
tsup doesn't have a top-level `define` key — use `esbuildOptions(options) { options.define = { ...options.define, 'process.env.KEY': JSON.stringify(value) } }` to inline env vars at build time. The spread preserves any existing defines. Without this, `process.env.GIT_COMMIT` stays as a runtime lookup and the fallback logic is unreachable after bundling.
