---
scope: [scope/backend, scope/services]
files: []
issue: 411
source: spec-review
date: 2026-03-16
---
Reviewer caught that AC4 used "Consider" with two alternative implementation outcomes, making it untestable. Root cause: the spec author was uncertain which approach was better and punted the decision to the implementer. Prevention: ACs must have a single pass/fail outcome — if the author isn't sure which approach is right, resolve it during spec writing (check codebase, weigh tradeoffs) and commit to one. "Consider X or Y" is never a valid AC.
