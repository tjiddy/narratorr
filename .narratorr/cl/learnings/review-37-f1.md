---
scope: [backend, infra]
files: [tsup.config.ts, scripts/tsup-inject.test.ts]
issue: 37
source: review
date: 2026-03-20
---
Build-time injection config changes (esbuildOptions.define, Vite define, webpack DefinePlugin) need a build-artifact test, not just unit tests on the source. Source-level unit tests (mocking process.env) verify the runtime fallback path but can't catch a broken define wiring. The gap: a bad esbuildOptions.define (wrong key, wrong format, silently no-op) lets all route/component tests pass while production images always return the fallback. Fix: write a spawnSync('pnpm build:server') test that reads the output bundle and asserts the literal injected value appears, not process.env lookup.
