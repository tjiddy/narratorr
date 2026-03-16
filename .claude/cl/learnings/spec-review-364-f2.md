---
scope: [scope/frontend]
files: []
issue: 364
source: spec-review
date: 2026-03-14
---
Test plan included "adding a new filter value in the future only requires adding to the context" — an architectural aspiration, not an observable test. Root cause: mixed up implementation guidance with test plan items. Test plans must describe observable pass/fail behavior, not hypothetical future ergonomics.
