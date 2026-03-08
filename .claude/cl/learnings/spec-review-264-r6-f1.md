---
scope: [scope/backend, scope/core]
files: [src/core/indexers/types.ts]
issue: 264
source: spec-review
date: 2026-03-08
---
AC4 required parsing `series_info` "for series metadata" but `SearchResult` has no series fields. The spec mentioned parsing the field without checking whether the adapter output contract had a destination for the parsed data. This created a non-deterministic AC — two implementers could both claim compliance with different behavior (parse-and-discard vs parse-and-expose).

Prevention: Before adding parsing requirements to ACs, verify that the parsed data has an explicit destination in the current type contract. If no destination exists, either add fields to the contract (with full wiring) or explicitly defer the parsing to a follow-up issue.
