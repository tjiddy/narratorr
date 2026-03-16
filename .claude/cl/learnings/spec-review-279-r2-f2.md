---
scope: [scope/backend, scope/frontend]
files: []
issue: 279
source: spec-review
date: 2026-03-10
---
Task metadata contract used "status" in ACs/UI but "running" in route tests — two incompatible API shapes. When a spec defines a data model, use the exact field names consistently across ACs, API route tests, and frontend tests. Pick the canonical shape once and reference it everywhere.
