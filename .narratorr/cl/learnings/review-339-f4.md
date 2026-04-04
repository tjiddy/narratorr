---
scope: [backend, api]
files: [src/server/routes/crud-routes.ts, src/server/routes/indexers.test.ts]
issue: 339
source: review
date: 2026-04-04
---
When a Zod schema chains multiple validators (e.g., `.number().int().positive()`), each validator is an independently breakable branch. A single rejection test (e.g., `id: -1`) only proves one validator (`.positive()`). Each chained constraint needs its own rejection test to prevent silent regression if one validator is accidentally dropped. Rule of thumb: one 400-path test per Zod chain segment.
