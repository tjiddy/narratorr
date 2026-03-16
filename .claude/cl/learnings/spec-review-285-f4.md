---
scope: [scope/backend, scope/db]
files: [src/db/schema.ts]
issue: 285
source: spec-review
date: 2026-03-11
---
Spec required "Added via [list name]" tag on books but never specified where to store it. Books table has no import-source column. /elaborate's defect vectors identified this gap but only as a test scenario, not as a missing data model decision. Fix: when /elaborate identifies a feature requiring new data on an existing entity, it should check whether the storage location exists and add an AC for the schema change if not.
