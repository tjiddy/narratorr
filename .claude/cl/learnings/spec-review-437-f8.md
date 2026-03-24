---
scope: [scope/backend, scope/core]
files: [src/core/metadata/types.ts]
issue: 437
source: spec-review
date: 2026-03-18
---
Reviewer caught that the ISP acceptance criterion said "split or methods made optional" but the test plan only covered the split-interface path. This meant an implementer could choose the optional-methods route, satisfy the AC, but fail the tests — internal inconsistency. Root cause: hedging in the AC to avoid committing to a design, while the test plan had already implicitly committed. Prevention: when an AC offers alternatives ("X or Y"), the test plan must cover both paths. If only one path is tested, the AC should require that path explicitly.
