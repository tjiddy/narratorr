---
skill: respond-to-pr-review
issue: 285
pr: 346
round: 1
date: 2026-03-11
fixed_findings: [F1, F2, F3, F4, F5, F6]
---

### F1: Provider-specific UI controls missing
**What was caught:** Settings page only rendered generic text inputs from `requiredFields`, with no provider-specific selectors, test button, or preview button.
**Why I missed it:** The `/implement` phase focused on getting CRUD working end-to-end and treated the settings form as a generic shell. The registry `requiredFields` metadata was used for rendering instead of creating provider-aware components. I prioritized getting the backend working and under-invested in the frontend.
**Prompt fix:** Add to `/implement` step for frontend modules: "When implementing settings for a multi-provider/multi-type system, create provider-specific settings components — not just generic field renderers. Check if fields have constrained values (dropdowns), require fetching options from an API (library selector), or need action buttons (test/preview)."

### F2: Server-side settings validation missing
**What was caught:** Create/update routes used a basic schema that accepted any settings blob, while provider-specific validation only lived in the form schema.
**Why I missed it:** I wrote the form-level validation with `superRefine` but didn't apply the same refinement to the server-side schema. The route test was passing full payloads that happened to be valid, masking the gap.
**Prompt fix:** Add to `/plan` schema validation step: "When validation logic (superRefine, custom refinements) exists in a form schema, verify the corresponding server route schema includes the same validation. Server must never accept data the form would reject."

### F3: ASIN detail lookup not implemented
**What was caught:** `enrichItem()` took the first search result's inline ASIN but never followed `providerId` to `metadata.getBook()` for ASIN enrichment.
**Why I missed it:** The search result often includes ASIN inline, so the happy path worked. I didn't implement the fallback detail lookup that the spec explicitly described.
**Prompt fix:** Add to `/implement` metadata integration step: "When the spec describes a multi-step data enrichment flow (search → detail lookup), implement ALL steps. Don't assume intermediate results contain all needed data."

### F4: Author dedup broken for new authors
**What was caught:** `resolveAuthorId()` only looked up existing authors, never created them. Books with new authors got `authorId = null`, which bypassed the `(title, authorId)` unique index since SQLite treats NULL as distinct.
**Why I missed it:** Didn't understand the SQLite NULL uniqueness semantics. Assumed the unique index would handle dedup even with NULL values.
**Prompt fix:** Add to `/plan` database step: "When dedup relies on a compound unique index with a nullable column, verify that the code ensures the column is populated before insert. SQLite unique indexes treat NULL as distinct — two rows with `(title, NULL)` are never duplicates."

### F5: Client provenance not completed
**What was caught:** Backend joined `importListName` into book responses, but the client `BookWithAuthor` type wasn't updated and no UI rendered the provenance tag.
**Why I missed it:** Treated backend and frontend as separate modules and forgot to follow through on the client side when adding the backend field.
**Prompt fix:** Add to `/implement` for cross-cutting features: "When a backend change adds a new field to an API response for a user-facing feature, immediately update the client type AND add the rendering. Check both ends before marking the feature complete."

### F6: Sync bookkeeping tests incomplete
**What was caught:** Service tests only asserted that providers were called, not the persistence payloads (lastRunAt, nextRunAt, lastSyncError, importListId, book_events).
**Why I missed it:** The chainable mock DB made it hard to assert specific insert/update payloads, so I took shortcuts by only asserting the entry point (provider.fetchItems called). Should have asserted observable outputs of each step.
**Prompt fix:** Add to `/implement` test writing step: "When testing a multi-step process (fetch → transform → persist), assert the observable outputs of EACH step, not just that the first step was called. For Drizzle mocks, assert through log messages and call counts when direct payload inspection is impractical."
