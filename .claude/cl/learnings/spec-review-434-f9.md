---
scope: [scope/backend, scope/services]
files: []
issue: 434
source: spec-review
date: 2026-03-18
---
Spec listed 4 affected test suites but the real blast radius is 9. When building an affected test suites list, grep for all imports of the service being extracted AND all test files that mock/assert the side effects being moved.
