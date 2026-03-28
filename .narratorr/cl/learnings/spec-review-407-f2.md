---
scope: [scope/backend]
files: []
issue: 407
source: spec-review
date: 2026-03-17
---
Reviewer caught contradictory observable behaviors: the design section said diversity picks are "appended" (structural guarantee) while the integration test plan said they are "intermixed sorted by score." These are different pass/fail conditions.

Root cause: Wrote the design section describing the generation-time mechanism (appending to candidate list) but used the same "appended" language in the test plan where it described query-time API behavior. Didn't re-read the existing API sort behavior (`orderBy(desc(suggestions.score))`) to reconcile.

Prevention: When a spec describes behavior at multiple layers (generation vs persistence vs query), write each layer's observable contract independently and cross-check for contradictions before finalizing.
