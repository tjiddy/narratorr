---
skill: respond-to-pr-review
issue: 71
pr: 75
round: 1
date: 2026-03-24
fixed_findings: [F1, F2, F3, F4, F5, F6]
---

### F1: {narratorLastFirst} joined all narrators instead of position-0 only
**What was caught:** `buildTargetPath()` rendered `{narratorLastFirst}` as all narrators joined with ` & ` (e.g., `"Kramer, Michael & Reading, Kate"`) rather than only the first narrator by position.
**Why I missed it:** The issue spec said path tokens use "first entity by position" but I wrote "join all" for the last-first variant, treating it differently without realizing it contradicted the spec. The test I wrote also asserted the wrong output, locking the regression in.
**Prompt fix:** Add to /implement step 3: "When implementing path tokens that apply transformations (e.g., `lastFirst`, `sort`), verify they apply to position-0 entity only, matching the behavior of the untransformed token. Check all sibling tests (import.service.test.ts) for the same helper."

### F2: Recycling bin stores only primary author name instead of all authors
**What was caught:** `moveToRecycleBin` stored only `authors[0].name` in `recyclingBin.authorName` instead of comma-joining all authors, despite the issue spec requiring a full denormalized snapshot.
**Why I missed it:** Spec said "comma-joined multi-author snapshot" but I copied the pattern of the old `book.authorName` single-field → `authors[0].name`, missing that the snapshot contract changed with the migration. The test also asserted the single-author behavior.
**Prompt fix:** Add to /plan step "snapshot contracts": "When migrating from a single FK/field to an array, any snapshot/archive tables that denormalize the data must store the FULL comma-joined value, not just the first element. Verify that the restore logic parses the joined snapshot back into individual entities."

### F3: Recycling bin narrator snapshot uses '; ' delimiter instead of issue-specified ', '
**What was caught:** Narrator snapshot used `'; '` separator but the issue spec explicitly required `', '` (comma). Restore parsing also used `'; '`. Tests asserted semicolon form.
**Why I missed it:** I chose `'; '` as a safe default without checking the issue spec for the exact delimiter. This is a contract mismatch.
**Prompt fix:** Add to /implement: "When the issue spec explicitly names a separator or delimiter for serialization (e.g., `', '` for recycling bin narrator snapshots), use exactly that string. grep the codebase for all places that join and split to verify consistency."

### F4: Delete route event snapshot omits narratorName despite new column existing
**What was caught:** The `DELETE /api/books/:id` route updated `authorName` to join but never passed `narratorName` to `eventHistory.create()`, even though the PR added support for it in the service and schema.
**Why I missed it:** I updated the author half of the event snapshot but didn't check all fields of the new `CreateEventInput` interface. The new `narratorName` field was in the type but wasn't connected at the call site.
**Prompt fix:** Add to /implement: "After adding a new field to a service input type (e.g., `CreateEventInput`), grep for all call sites and verify each one passes the new field. Use `grep -n 'eventHistory.create' src/server/routes/` to enumerate all sites."

### F5: Narrator dedup missing while author dedup was present
**What was caught:** `book.service.ts` deduplicated authors by slug before inserting but iterated narrators raw, risking composite PK violations on duplicate narrator payloads.
**Why I missed it:** I applied dedup logic to authors (which had a test) but didn't symmetrically apply it to narrators even though the issue spec required both. Asymmetric application of the same fix pattern is a common miss.
**Prompt fix:** Add to /implement: "When deduplication logic is required for multiple entity types (authors and narrators), verify the logic is applied symmetrically. If you add dedup for one, immediately grep the same method for the other and add it too."

### F6: Quality gate rejoins narrator array and re-splits on delimiters
**What was caught:** The narrator comparison in `quality-gate.helpers.ts` rejoined `book.narrators` to `'; '` and then tokenized on `/[,;&]/`, reintroducing the delimiter heuristic the migration was supposed to eliminate.
**Why I missed it:** I updated the surrounding code to use `book.narrators` array but the join-and-tokenize pattern inside the comparison block was the old `book.narrator` string approach carried over. I updated the data source but not the comparison logic.
**Prompt fix:** Add to /implement: "When migrating from a string field to an array, grep for any code that joins the array back to a string before processing. Join+split patterns that re-introduce delimiter heuristics are a sign the consumer wasn't fully migrated."
