---
skill: review-spec
issue: 367
round: 4
date: 2026-03-16
new_findings_on_original_spec: [F12, F13, F14]
---

### F12: Suggestion DTO fields do not match the merged backend payload
**What I missed in round 1:** The spec's `Suggestion` interface still names `author`, `narrator`, `series`, and `reasonType`, but the merged backend returns `authorName`, `narratorName`, `seriesName`, and `reason` directly from the DB-backed row shape.
**Why I missed it:** I previously focused on the existence of the discover endpoints and settings wiring, but I did not mechanically diff the spec's field names against the final route response shape after the dependency landed.
**Prompt fix:** Add: "For every dependency contract in the spec, compare the exact response field names returned by the merged route handler to the DTO documented in the issue. Treat any rename or alias assumption as a blocking alignment defect unless a mapping layer is explicitly specified."

### F13: Add-to-library response contract does not match the merged backend
**What I missed in round 1:** The spec still documents `POST /api/discover/suggestions/:id/add` as returning `{ bookId: number }`, but the merged route returns `{ suggestion, book }` and may also include `duplicate: true`.
**Why I missed it:** I did not audit the non-GET route response bodies with the same rigor as the read endpoints during the earlier round.
**Prompt fix:** Add: "When a spec names mutation routes, verify the exact success payload and status code for each mutation, not just the URL and method. Include duplicate/idempotency branches if present in route tests."

### F14: Refresh route status/body does not match the merged backend
**What I missed in round 1:** The spec says `POST /api/discover/refresh` returns `202`, but the merged backend returns `200` with a JSON result body.
**Why I missed it:** I checked that the route existed but did not cross-check the documented status code/body against the route test once the backend dependency was merged.
**Prompt fix:** Add: "For each referenced route, verify method, path, status code, and body shape from both the handler and its tests. A route existence check alone is insufficient."
