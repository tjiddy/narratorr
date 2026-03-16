---
scope: [scope/frontend, scope/api]
files: []
issue: 282
source: spec-review
date: 2026-03-10
---
Spec said "POST array of book IDs to batch endpoints" in technical notes but no batch endpoints exist. Test plan said "calls delete API for each selected book" — contradicting the technical notes. When a spec references API operations on multiple items, must explicitly choose between batch endpoint vs client-side fan-out and define the request/response contract, partial failure semantics, and toast messaging format.
