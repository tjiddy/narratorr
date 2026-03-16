---
scope: [scope/services]
files: []
issue: 349
source: spec-review
date: 2026-03-15
---
The spec said "existing tests continue to pass" without naming the specific E2E suites that cover import side effects. The import method has regression coverage across 4 test files (unit + 3 E2E), and an implementer unaware of the E2E suites could update unit test mocks while silently breaking integration behavior. When a refactor touches a method with E2E coverage, name the specific test files in the AC so implementers know the full regression surface.
