---
scope: [backend, api]
files: [src/server/routes/settings.test.ts]
issue: 332
source: review
date: 2026-03-10
---
Added a new settings field (housekeepingRetentionDays) with Zod validation (min/max/int) but didn't add route-level tests to verify the API boundary rejects invalid values. Schema-level tests in registry.test.ts covered Zod parsing, but the route test file is the API contract — it should independently verify that invalid payloads get 400s. Pattern: any new settings field with validation constraints needs both schema tests AND route tests for the round-trip and rejection paths.
