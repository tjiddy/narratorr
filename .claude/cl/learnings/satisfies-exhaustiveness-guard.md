---
scope: [scope/backend, scope/db]
files: [src/shared/indexer-registry.ts, src/shared/download-client-registry.ts, src/shared/import-list-registry.ts, src/shared/notifier-registry.ts]
issue: 429
date: 2026-03-17
---
When narrowing Record<string, T> to Record<LiteralType, T> for compile-time completeness, existing consumers that index with `string` break. The pattern `Record<string, T> = { ... } satisfies Record<LiteralType, T>` gives both: compile-time enforcement that all literal keys are present (via satisfies) AND runtime compatibility with string indexing (via the explicit Record<string, T> type annotation). This was the key pattern enabling registry-driven enum derivation without breaking existing code.
