---
scope: [backend, services]
files: [src/server/jobs/search.test.ts]
issue: 357
source: review
date: 2026-03-13
---
Reviewer caught that the test was updated to match the regression instead of protecting the old contract. When a refactor changes observable behavior (counter values returned by a function), updating the test to match the new behavior is masking a bug, not fixing a test. The correct response is: if the old test assertion was right, fix the code to preserve it. Only update test assertions when the behavioral change is intentional and spec-approved.
