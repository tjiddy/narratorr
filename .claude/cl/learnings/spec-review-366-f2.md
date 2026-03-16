---
scope: [scope/backend, scope/core]
files: [src/core/metadata/audible.ts, src/core/metadata/types.ts]
issue: 366
source: spec-review
date: 2026-03-16
---
Reviewer caught that the spec said "increase MAX_RESULTS from 10 to 25 for discovery queries" but MAX_RESULTS is a single global constant used by all searchBooks callers. This is an OCP-2 violation — the spec proposed modifying shared behavior instead of extending with a new option. Gap: `/elaborate` identified this as a defect vector but didn't elevate it to a spec fix. The elaborate step should have checked whether implementation hints in the spec would modify shared constants/interfaces and flagged them as design issues, not just implementation hazards.
