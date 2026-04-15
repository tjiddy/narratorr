---
scope: [backend, core]
files: [src/shared/schemas/indexer.ts]
issue: 557
source: review
date: 2026-04-15
---
ZOD-1 violation: `mamId` and `hostname` used `.min(1)` without `.trim()` in new server-side schemas. The existing form schema already had trim on all fields, but the new per-adapter server schemas were written from adapter config interfaces (which don't trim) rather than from the form schema (which does). When creating new Zod schemas, check CLAUDE.md's ZOD-1 rule for every `.min(1)` call — the `/plan` architecture checks flagged it but implementation still missed it.
