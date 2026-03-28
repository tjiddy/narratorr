---
scope: [scope/backend]
files: [src/server/routes/discover.ts, src/shared/schemas/discovery.ts]
issue: 448
source: spec-review
date: 2026-03-18
---
Round 1 fix for SuggestionRow said compile-time verification would happen via typecheck, but the discovery route returns DB-row types directly without any reference to the shared response type. Without an explicit mapper or type annotation, typecheck cannot prove the shared type matches the route output.

Root cause: Assumed that defining a shared type was sufficient for compile-time safety, but TypeScript only enforces types at assignment/return boundaries. If no code references the shared type on the server side, it is just documentation that can drift.

Prevention: When introducing shared API response types, always specify the compile-time enforcement mechanism: a typed mapper function, a satisfies assertion, or a return type annotation on the route. The spec must name which approach is used and where.
