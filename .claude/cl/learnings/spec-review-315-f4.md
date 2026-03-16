---
scope: []
files: []
issue: 315
source: spec-review
date: 2026-03-11
---
AC3 required a re-encryption command for key changes, but the out-of-scope section explicitly excluded re-encryption CLI. Internal contradiction in the same spec. Lesson: after writing AC and scope boundaries, do a contradiction check — does any AC require something the scope excludes?
