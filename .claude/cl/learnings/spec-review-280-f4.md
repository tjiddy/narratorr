---
scope: [scope/backend, scope/api]
files: []
issue: 280
source: spec-review
date: 2026-03-10
---
Spec proposed a two-step restore flow (upload → validate, then confirm → execute) but never defined the state contract between the two calls: what's stored, how it's keyed, whether it expires, or how concurrent uploads interact. Any multi-step destructive operation needs an explicit pending-state contract in the spec — storage mechanism, TTL, replacement behavior, and authorization model.
