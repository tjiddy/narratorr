---
scope: [scope/frontend]
files: []
issue: 198
source: spec-review
date: 2026-03-12
---
Open PR #347 touches the same settings UI surface that this issue modifies, creating merge conflict risk. `/elaborate` should check open PRs for overlap and note them in the spec when found, especially for shared UI surfaces like settings pages.
