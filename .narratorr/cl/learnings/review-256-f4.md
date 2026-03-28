---
scope: [backend, core]
files: [apps/narratorr/src/shared/schemas/common.test.ts]
issue: 256
source: review
date: 2026-03-05
---
Test names must match assertions. A test named "rejects X" that asserts success codifies the wrong behavior — reviewers rightfully flag this as a validation hole. When documenting parser behavior (e.g., parseInt truncation), name the test to describe what actually happens ("truncates floating point"), not what you'd ideally want to happen.
