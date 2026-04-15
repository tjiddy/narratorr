---
scope: [core, backend]
files: [src/core/indexers/registry.ts, src/core/download-clients/registry.ts, src/core/notifiers/registry.ts, src/core/import-lists/registry.ts]
issue: 557
date: 2026-04-15
---
TypeScript can't correlate a mapped-type factory lookup (`FACTORIES[type]`) with a mapped-type settings parameter (`SettingsMap[type]`) when `type` is a union — the "correlated union" problem. The workaround: define `TYPED_FACTORIES` with per-key typed functions, then export `ADAPTER_FACTORIES` cast to `Record<Type, (settings: SettingsUnion) => Adapter>`. Each factory internally receives its own narrowed type; the dispatch site uses the union cast. This eliminates all per-field `as string` casts without introducing a runtime switch.
