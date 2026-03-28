---
scope: [scope/backend, scope/core]
files: []
issue: 431
source: spec-review
date: 2026-03-17
---
Reviewer caught that the AC list omitted two problem areas (fireAndForget, internal-server-error helper) that the problem statement and test plan both assumed were in scope. The spec was internally inconsistent -- problem statement listed them, test plan tested them, but AC didn't require them. Root cause: AC was written before the test plan was generated, and the test plan gap-fill (from /elaborate) added sections without cross-checking whether the AC covered them. Prevention: after generating test plan sections, verify every test plan section maps to an AC item.
