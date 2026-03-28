---
scope: [scope/backend, scope/frontend]
files: [src/server/routes/discover.ts, src/shared/schemas/discovery.ts]
issue: 448
date: 2026-03-18
---
Drizzle $inferSelect widens text enum columns to string. When mapping DB rows to a shared response type with literal union fields (e.g., SuggestionReason), you need an explicit cast: `reason: row.reason as SuggestionRowResponse['reason']`. This is a known Drizzle gotcha already in CLAUDE.md but manifests specifically at the mapper boundary when the shared type uses the actual enum union.
