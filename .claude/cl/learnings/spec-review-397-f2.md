---
scope: [scope/services, scope/backend]
files: []
issue: 397
source: spec-review
date: 2026-03-15
---
Spec review caught that the test plan didn't call out the blast radius of mock/dependency updates needed in test files when splitting a service. For refactors that change constructor/parameter surfaces, the highest risk is stale mocks — not behavioral regressions. The test plan should always list affected test files and what specifically changes in each (new mock, updated dependency injection, moved test cases).
