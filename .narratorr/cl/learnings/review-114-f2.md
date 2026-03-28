---
scope: [backend, api]
files: [src/shared/schemas/library-scan.ts, src/server/routes/library-scan.ts]
issue: 114
source: review
date: 2026-03-25
---
The scan route only had a request body schema; the response shape was enforced by TypeScript alone. Runtime reply validation (Zod `.parse()` on the response) catches type mismatches between service and HTTP boundary. The test plan required "Schema validation enforces isDuplicate: boolean" but the implementation only added forceImport to the request schema. A discoveredBookSchema + scanResultSchema should be added any time a response contract is specified in the AC.
