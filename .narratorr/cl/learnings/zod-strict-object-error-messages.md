---
scope: [backend]
files: [src/shared/schemas/import-list.ts, src/server/routes/import-lists.test.ts]
issue: 557
date: 2026-04-15
---
When migrating from registry-driven `superRefine` validation (custom messages like "API key is required") to per-type Zod schemas with `.min(1)`, the error messages change. A missing required field produces Zod's default "expected string, received undefined" instead of the custom message. Tests asserting specific error text need updating. The field path (e.g., `settings/apiKey`) remains actionable even without the custom message.
