---
scope: [scope/frontend]
files: []
issue: 367
source: spec-review
date: 2026-03-16
---
Spec described filtering as "client-side" in AC 3 but simultaneously defined a `reasonType` query param in the dependency contract, a `filters?` param on the API client method, and parameterized query keys. The reviewer caught that these encode server-side filtering. When specifying a filtering strategy, every mention of filtering across AC, API contract, API client, and query keys must be internally consistent. A single contradictory reference creates ambiguity about the implementation approach.
