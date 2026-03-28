---
scope: [scope/backend]
files: []
issue: 408
source: spec-review
date: 2026-03-17
---
AC6 used the phrase "reason tags" (plural) when the actual model has singular `reason` enum + `reasonContext` string, and the existing `refreshSuggestions()` overwrites both fields on update. The reviewer caught that the AC was ambiguous about which fields are preserved on resurfacing. Root cause: the spec was written against an assumed data model instead of checking the actual schema and refresh behavior in `discovery.service.ts:103-107`. Would have been caught by verifying AC field references against `src/db/schema.ts` and the service's update logic before finalizing.