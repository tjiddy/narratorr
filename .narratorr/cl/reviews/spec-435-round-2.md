---
skill: respond-to-spec-review
issue: 435
round: 2
date: 2026-03-18
fixed_findings: [F1, F2, F3, F4, F5, F6, F7]
---

### F1: Phantom production caller in caller matrix
**What was caught:** `getQualityGateData()` listed as having a production caller via `GET /api/activity/:id`, but the route doesn't call it.
**Why I missed it:** Caller matrix built from method names, not verified with `rg` against actual route handlers.
**Prompt fix:** Add to `/elaborate` step 3: "For every method in the caller matrix, verify with `rg` that the production caller actually invokes it. Flag methods with no production callers."

### F2: Undefined post-extraction API surface
**What was caught:** Spec said "returns a decision" without method signatures, visibility changes, or return types.
**Why I missed it:** Focused on what moves out, not what the remaining service API looks like.
**Prompt fix:** Add to `/elaborate` step 4: "For extraction specs, add a Post-Extraction API Surface table with method names, visibility, return types, and responsibilities."

### F3: Approve-path import-slot flow omitted
**What was caught:** Approve route acquires import slots and branches on `processing_queued` — not just SSE/events.
**Why I missed it:** Only read the service method, not the full route handler.
**Prompt fix:** Add to `/elaborate` step 3: "For every caller, READ THE FULL CALLING CODE (route, job), not just the service method. Note cross-service flow control."

### F4: revertBookStatus left as unresolved design decision
**What was caught:** DownloadOrchestrator already handles `revertBookStatus` — pattern exists.
**Why I missed it:** Treated ownership as novel without checking existing orchestrators.
**Prompt fix:** Add to `/elaborate` step 3: "For ambiguous ownership, check existing orchestrators for the same pattern before flagging as open."

### F5: Shared orchestration pattern deferred despite existing solution
**What was caught:** Pattern already established by DownloadOrchestrator and ImportOrchestrator.
**Why I missed it:** Took original issue's "proposed direction" at face value without checking current codebase.
**Prompt fix:** Add to `/elaborate` step 3: "When spec defers a pattern, check if it's been established since the spec was written."

### F6: AC6 about complexity disables was untestable
**What was caught:** Only quality-gate complexity disable is in helpers.ts (out of scope), not the service.
**Why I missed it:** Didn't grep to verify which files have the disables.
**Prompt fix:** Add to `/elaborate` step 4: "For lint suppression ACs, grep target files to confirm baseline before writing criterion."

### F7: Blast radius table too narrow
**What was caught:** Missing jobs/import.ts, jobs/import.test.ts, routes/index.ts.
**Why I missed it:** Only checked co-located test files.
**Prompt fix:** Add to `/elaborate` step 4: "Grep for service class/variable across entire src/ tree for blast radius."
