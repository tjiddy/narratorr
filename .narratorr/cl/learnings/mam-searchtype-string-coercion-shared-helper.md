---
scope: [backend, frontend]
files: [src/shared/indexer-registry.ts, src/core/indexers/registry.ts, src/client/components/settings/IndexerCard.tsx]
issue: 363
date: 2026-04-05
---
When changing a type from number to string across the stack, the coercion logic (legacy integer → new string) is needed in multiple places — both the backend adapter factory and the frontend edit-form hydration. Extracting a shared helper (coerceSearchType) in the shared layer prevents divergence. The return type must be a literal union (not bare `string`) to satisfy Zod enum schemas downstream.
