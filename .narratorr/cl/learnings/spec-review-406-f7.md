---
scope: [scope/backend]
files: []
issue: 406
source: spec-review
date: 2026-03-17
---
Boundary test expectation ("all weights at floor") was carried over from before the formula was locked down in round 1. After fixing F1 to specify exact formula outputs, didn't re-validate that all downstream references to the formula's behavior were consistent with the new numbers. Prevented by: after fixing a formula/contract finding, grep the spec for all references to the old behavior and update each one.
