---
scope: [scope/backend]
files: []
issue: 406
source: spec-review
date: 2026-03-17
---
Reviewer caught that AC3 used "e.g." for the dampening formula instead of specifying an exact contract. The spec missed this because the formula felt obvious enough to leave as an example, but "e.g." makes the AC non-deterministic — two valid implementations could produce different outputs. Spec should have included the exact formula AND a table of expected ratio→multiplier values so tests can assert specific numbers. Prevention: when an AC references a formula or algorithm, always pin it with exact expected input→output pairs.