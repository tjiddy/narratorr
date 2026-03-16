---
scope: [scope/backend, scope/services]
files: []
issue: 355
source: spec-review
date: 2026-03-13
---
When a spec says "all four routes" or "all N services," each must be explicitly named in AC and test plan — don't let any hide behind the group label. Blacklist was implicitly included but had no explicit AC, test coverage, or client-side contract mention, making it easy to miss during implementation.
