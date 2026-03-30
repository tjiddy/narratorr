---
scope: [core]
files: [src/core/utils/naming.ts]
issue: 228
source: review
date: 2026-03-30
---
The spec said empty template → empty tokens, no errors, but the test codified the old behavior (errors array contains "missing title"). Prevention: when the spec explicitly defines a contract for a boundary value, the test must assert exactly that contract — not the pre-existing behavior. Read the spec bullet literally during red-phase test writing.
