---
scope: [scope/backend, scope/services]
files: []
issue: 434
source: spec-review
date: 2026-03-18
---
Spec listed `src/server/routes/download.test.ts` in the Affected Test Suites table, but that file doesn't exist — route tests live in `activity.test.ts` and `search.test.ts`. The elaboration subagent inferred file names from the service name pattern rather than verifying they exist. Always verify named artifacts (file paths, function names, test suite names) with glob/ls before including them in a spec.
