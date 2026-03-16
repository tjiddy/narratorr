---
scope: [scope/api, scope/services]
files: [src/shared/schemas/import-list.ts]
issue: 285
source: review
date: 2026-03-12
---
When adding superRefine validation to a create schema, check if the same entity has an update schema that also accepts the validated fields. In this case, `createImportListSchema` got `validateRequiredSettings` but `updateImportListSchema` was missed, leaving the edit/PUT path unvalidated. Always grep for all schema variants (create/update/patch) when adding validation logic.
