---
scope: [scope/backend, scope/db]
files: [apps/narratorr/src/server/services/download.service.ts, apps/narratorr/src/server/services/download.service.test.ts]
issue: 240
source: spec-review
date: 2026-02-24
---
Reviewer caught that AC/test plan items like "only one active download record exists" aren't directly testable in service-level tests with mocked DBs. Service tests assert mock call counts (`db.insert` called N times) and method return values, not actual DB state. AC must specify the testable mechanism (which mock is called/not called, what error is thrown, what value is returned) rather than describing the desired DB state abstractly. This was missed because the AC was written from a "what should happen" perspective rather than a "how do we verify it" perspective.
