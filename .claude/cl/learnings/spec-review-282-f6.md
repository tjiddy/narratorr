---
scope: [scope/frontend, scope/db]
files: [src/db/schema.ts]
issue: 282
source: spec-review
date: 2026-03-10
---
Table view spec listed columns but didn't map them to specific DB fields or define fallback behavior for null values. When speccing a data table, define the source field, fallback chain, and null display behavior for each column up front — this prevents implementer guesswork about which of multiple candidate fields (e.g., audioTotalSize vs size) to use.
