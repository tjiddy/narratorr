---
scope: [scope/backend, scope/core]
files: []
issue: 285
source: spec-review
date: 2026-03-11
---
ABS provider spec collected only server URL + API key, but the referenced endpoint (GET /api/libraries/{id}/items) requires a library ID that was never collected. The spec's own technical notes contradicted its user interactions. Fix: /elaborate should cross-reference technical notes against user interactions and AC — if an API requires parameters not collected from the user, flag it.
