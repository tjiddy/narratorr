---
scope: [scope/api, scope/frontend]
files: []
issue: 358
source: spec-review
date: 2026-03-13
---
Reviewer caught that the spec's caller/test sweep for API method renames was a partial list, missing `api-contracts.test.ts` (which calls every renamed method directly through module imports) and `DownloadClientCard.test.tsx` (which mocks `getMappingsByClientId`). The spec missed these because `/elaborate` only grepped for `api.methodName` patterns through the barrel export, not for module-level imports like `authApi.getStatus()`. Fix: when specifying rename blast radius, require an exhaustive grep for both barrel-export callers (`api.oldName`) and module-level callers (`moduleApi.oldName`), and phrase AC as "exhaustive sweep" rather than closed lists.
