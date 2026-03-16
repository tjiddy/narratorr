---
scope: [infra]
files: [scripts/lib.ts]
issue: 323
source: review
date: 2026-03-09
---
GitHub/Gitea closing keywords include `resolves` in addition to `closes` and `fixes`. When implementing closing keyword parsing, check the platform docs for the full set rather than relying on memory. The orchestrator already matched `resolves` — keyword set mismatch between components causes silent behavior divergence.
