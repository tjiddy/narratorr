---
scope: [scope/frontend]
files: []
issue: 367
source: spec-review
date: 2026-03-16
---
Reviewer caught that the Suggestion interface in the dependency contract used invented field names (`author`, `narrator`, `series`, `reasonType`) instead of the actual DB column names from `src/db/schema.ts` (`authorName`, `narratorName`, `seriesName`, `reason`). The spec was updated post-#366 merge but the contract was only partially refreshed — the DTO shape was carried forward from the pre-merge spec draft without verifying each field against the actual schema/service return type. Prevention: when refreshing a dependency contract after the dependency merges, read the actual schema definition and service return type, don't just update the parts you remember changed.
