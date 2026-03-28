---
scope: [backend]
files: [src/shared/schemas/import-list.ts, src/shared/schemas/indexer.ts, src/shared/schemas/download-client.ts]
issue: 145
date: 2026-03-26
---
Schemas using .superRefine() to validate type-specific required settings (indexer, import-list, download-client) reject test data that doesn't satisfy the per-type required fields. When writing tests for these schemas, always check the registry's requiredFields for the chosen type and provide them in the test fixture. Using type: 'newznab' with empty settings fails because newznab requires apiUrl and apiKey; use a type with simpler requirements (e.g., 'abb' with { hostname: '...' }) or provide the full required settings.
