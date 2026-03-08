---
scope: [scope/backend, scope/core]
files: []
issue: 264
source: spec-review
date: 2026-03-08
---
AC6 said test method should hit "user profile or dynamic seedbox check" — two different endpoints with different response shapes. This left the implementer free to choose either, making the AC non-deterministic. The fix was specifying exactly one endpoint (`GET /jsonLoad.php`) with its expected response field (`username`). Spec ACs that reference external APIs should always pin a single endpoint and expected response contract, not offer alternatives.
