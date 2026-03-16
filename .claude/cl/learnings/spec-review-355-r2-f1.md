---
scope: [scope/backend, scope/services]
files: []
issue: 355
source: spec-review
date: 2026-03-13
---
When adding pagination to existing APIs, "large explicit limit" is not a real transition strategy — it's just a bigger truncation. The correct approach: make pagination opt-in (no limit/offset → full results), change only the response shape, and defer limit enforcement to the follow-up issue that adds pagination UI. This preserves correctness while still shipping the infrastructure.
