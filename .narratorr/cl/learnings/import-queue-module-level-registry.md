---
scope: [backend, services]
files: [src/server/services/import-adapters/registry.ts, src/server/__tests__/e2e-helpers.ts]
issue: 635
date: 2026-04-17
---
Module-level mutable state in adapter registries (Map-based) persists across test files in Vitest. E2E helpers and any test that calls `createServices()` must call `clearImportAdapters()` before re-registering adapters, otherwise the duplicate-type guard throws. This pattern also applies to any future module-level registries.
