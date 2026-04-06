---
scope: [frontend]
files: [src/client/components/settings/indexer-fields/index.ts, src/client/components/settings/notifier-fields/index.ts]
issue: 371
date: 2026-04-06
---
When React components can't live in `shared/` (server+client boundary), a barrel export in a client-side directory is an effective OCP pattern. The barrel's `Record<string, Component>` map is the sole registration point — adding a new type means creating a new component file and adding one line to the barrel. Existing wiring files (the thin dispatcher) never need editing.
