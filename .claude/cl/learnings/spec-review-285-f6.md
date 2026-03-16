---
scope: [scope/backend, scope/db]
files: [src/server/services/book.service.ts, src/db/schema.ts]
issue: 285
source: spec-review
date: 2026-03-11
---
Spec claimed findDuplicate() handles concurrent imports, but it's a read-before-insert check with no DB uniqueness constraint on books. /elaborate's defect vectors identified the race but proposed testing it rather than fixing the architectural gap. Fix: when /elaborate identifies a concurrency defect vector, it should check whether DB constraints exist to back up the application-level check, and flag missing constraints as an AC gap.
