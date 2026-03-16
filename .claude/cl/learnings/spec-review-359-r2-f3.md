---
scope: [scope/backend, scope/frontend]
files: []
issue: 359
source: spec-review
date: 2026-03-14
---
Round 2 review caught that L-23's verification steps checked for `core/` imports (M-6's surface) instead of `shared/schemas/*` sub-path imports (L-23's actual concern). Root cause: when adding test plan entries for L-23 in round 1, I copy-pasted from M-6's grep check without adjusting the target path pattern. Would have been prevented by defining L-23's exact scope (which files, which import pattern) before writing verification steps.
