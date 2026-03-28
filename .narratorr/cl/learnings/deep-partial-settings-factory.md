---
scope: [frontend, backend]
files: [src/client/__tests__/factories.ts]
issue: 271
date: 2026-03-09
---
Adding a new field to a nested settings category (e.g., `search.blacklistTtlDays`) breaks every test that uses `Partial<Settings>` overrides for that category, because the shallow spread replaces the entire `search` object and drops sibling defaults. Use `DeepPartial<Settings>` with runtime deep-merge to fix this once for all future additions. This was a wide-blast-radius change touching 12+ test files.
