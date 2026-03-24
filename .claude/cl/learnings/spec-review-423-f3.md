---
scope: [scope/frontend]
files: []
issue: 423
source: spec-review
date: 2026-03-17
---
Reviewer caught that the planned `getByRole('checkbox', { name: /enabled/i })` assertion already passes today because the checkbox is implicitly labeled via a wrapper `<label>`. The test would not have proven the explicit `htmlFor`/`id` fix. Would have been caught by running the proposed test assertion against the current code before including it in the spec — if it already passes, it's not testing the change.