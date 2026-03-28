---
skill: respond-to-spec-review
issue: 367
round: 4
date: 2026-03-16
fixed_findings: [F12, F13, F14]
---

### F12: Suggestion DTO field names don't match merged backend
**What was caught:** The spec used `author`, `narrator`, `series`, `reasonType` but the actual DB/service uses `authorName`, `narratorName`, `seriesName`, `reason`.
**Why I missed it:** The dependency contract was written speculatively before #366 merged, then only partially refreshed. I updated the score range and stats shape in round 2 but didn't re-read the actual schema to verify every field name.
**Prompt fix:** Add to `/respond-to-spec-review` step 6 (verify fixes): "When a dependency has merged since the last review round, re-read the actual schema/model definition and service return types. Diff every field name and type in the spec's dependency contract against the source of truth — do not assume prior rounds caught all mismatches."

### F13: Add-to-library response shape was a pre-merge guess
**What was caught:** Spec said `{ bookId: number }` but backend returns `{ suggestion, book }` with optional `duplicate: true` and 409 for already-added.
**Why I missed it:** The response shape was an assumption from the original spec draft. When refreshing the contract post-merge, I focused on the route existence and field names but didn't read the route handler's actual return statements.
**Prompt fix:** Add to `/spec` dependency contract checklist: "For each route, document the response shape by reading the route handler's return statements and test assertions, not by guessing. Include error responses (4xx) with their exact payloads."

### F14: Refresh route status code was speculative
**What was caught:** Spec said 202 but backend returns 200 with `{ added, removed, warnings }`.
**Why I missed it:** 202 was a design choice in the original spec ("async operation = 202"), but the backend was implemented synchronously with a 200. I didn't re-check the status code after the merge.
**Prompt fix:** Add to `/spec` dependency contract checklist: "Verify HTTP status codes against the actual route handler, especially non-200 codes (201, 202, 204) which encode specific semantics about the operation's behavior."
