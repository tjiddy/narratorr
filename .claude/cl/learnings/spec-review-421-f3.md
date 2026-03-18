---
scope: [scope/backend]
files: []
issue: 421
source: spec-review
date: 2026-03-17
---
AC2 modifies a shared test helper (`createMockServices`) used ~60 times across server tests, but the spec didn't call out the blast radius or specify that the full server test suite must pass. For shared test infrastructure changes, always include explicit regression verification scope in the test plan.
