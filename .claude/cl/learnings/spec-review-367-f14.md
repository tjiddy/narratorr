---
scope: [scope/frontend]
files: []
issue: 367
source: spec-review
date: 2026-03-16
---
Reviewer caught that the refresh route was documented as returning `202` when the actual merged backend returns `200` with a JSON body `{ added, removed, warnings }`. This was a speculative status code choice from the pre-merge draft. Prevention: verify HTTP status codes against the actual route handler — especially for non-standard codes like 202 which imply async processing that may not be how the backend was actually implemented.
