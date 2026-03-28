---
scope: [scope/backend, scope/core]
files: [src/shared/download-status-registry.ts, src/server/jobs/monitor.ts]
issue: 431
source: spec-review
date: 2026-03-17
---
Reviewer caught that replacing hardcoded monitor statuses with getInProgressStatuses() would broaden polling to 7 statuses (including internal pipeline states) when monitor only needs 3 external-client statuses. Prevention: when proposing registry function substitutions, read what the function actually returns and compare to the current hardcoded values.
