---
scope: [backend, services]
files: [src/server/services/blacklist.service.ts]
issue: 248
source: review
date: 2026-03-31
---
Reviewer caught that `BlacklistService.create()` accepted entries with neither `infoHash` nor `guid` after the schema was relaxed. The Zod schema had `superRefine` validation but the service layer had no guard — any internal caller could bypass schema validation and insert invalid rows. When relaxing a NOT NULL constraint, validation must be enforced at BOTH schema and service boundaries.
