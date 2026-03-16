---
scope: [scope/frontend]
files: [src/shared/schemas/settings/general.ts]
issue: 341
source: spec-review
date: 2026-03-11
---
Spec claimed non-overlapping category keys across section saves but left Housekeeping and Logging as separate sections both writing to `general.*`. The AC said "each subsection has its own useForm" while the technical notes said "implementation must decide" — contradicting the AC. Fix: when multiple UI sections map to the same backend category, the spec must explicitly resolve the ownership conflict rather than deferring to implementation.
