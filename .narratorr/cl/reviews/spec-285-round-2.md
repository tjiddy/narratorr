---
skill: respond-to-spec-review
issue: 285
round: 2
date: 2026-03-11
fixed_findings: [F9, F10, F11, F12]
---

### F9: Poller wake-up cadence unspecified
**What was caught:** The single-poller job had per-row `nextRunAt` but no defined wake-up interval for the poller itself.
**Why I missed it:** Round 1 fix focused on the per-list scheduling model (query DB for due rows) without recognizing that the global poller also needs a concrete cadence. I treated "timeout-loop" as self-explanatory when it actually requires a scheduler interval source.
**Prompt fix:** Add to /respond-to-spec-review step 5 verification: "For any polling/scheduler fix, verify the spec defines BOTH the polling cadence (how often the job wakes) and the per-entity scheduling (how each row determines its next run). A poller without a defined cadence is untestable."

### F10: Preview route vs UX flow mismatch
**What was caught:** `POST /:id/preview` requires a saved row, but the UI test plan says "preview before committing config."
**Why I missed it:** Round 1 promoted preview from test plan to AC but copied the `/:id` pattern from existing CRUD routes without checking whether the UX flow (preview unsaved data) was compatible with a saved-row route.
**Prompt fix:** Add to /respond-to-spec-review step 5 verification: "When promoting a test plan endpoint to an AC, verify the route shape (`:id` vs body payload) matches the UX flow described in the frontend test plan. `:id` routes require saved data; body routes support unsaved data."

### F11: Dead priority column
**What was caught:** `priority` column had no defined behavior — it was copied from the indexer/download-client pattern without a use case.
**Why I missed it:** Round 1 carried `priority` from the existing table pattern (indexers have it) without asking whether import lists actually need priority-based processing. Mechanical pattern copying without behavioral justification.
**Prompt fix:** Add to /elaborate step 4 gap-fill: "When copying schema columns from existing table patterns, verify each column has a defined behavior in the new feature's ACs. Drop columns that are present only by analogy without a concrete use case."

### F12: Book API missing import list name contract
**What was caught:** `importListId` FK was defined but the API response shape for `importListName` was not — UI couldn't render "Added via [list name]" without knowing where the name comes from.
**Why I missed it:** Round 1 defined the storage model (FK on books) without tracing the data flow all the way to the API response. The UI AC assumed the name would be available without specifying the JOIN or response shape.
**Prompt fix:** Add to /respond-to-spec-review step 5 verification: "For any FK added to an entity, trace the data flow to the API response: does the existing API response type include the joined/derived field the UI needs? If not, add an AC for the API response shape."
