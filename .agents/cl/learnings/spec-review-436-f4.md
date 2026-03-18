---
scope: [scope/backend, scope/services]
files: []
issue: 436
source: spec-review
date: 2026-03-17
---
Reviewer noted the spec should call out that most extracted side-effect code already lives in import-steps.ts. Without this, an implementer might rewrite helpers that already exist. Root cause: spec focused on the "what moves" without acknowledging "where it already is." Fix: for extraction specs, always identify existing prior art / extraction seams and state whether the new layer composes or replaces them.