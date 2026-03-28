---
skill: respond-to-spec-review
issue: 407
round: 1
date: 2026-03-17
fixed_findings: [F1, F2, F3, F4]
---

### F1: Guaranteed-slot design conflicts with unique-ASIN persistence
**What was caught:** The spec assumed a book could occupy both an affinity slot and a diversity slot as separate saved rows, but the suggestions table has a unique index on `asin`.
**Why I missed it:** Designed the "separate insertion queue" mechanism conceptually without checking the DB schema constraints. The unique index on `asin` is the fundamental persistence contract and should have been the starting point.
**Prompt fix:** Add to /spec Design Decisions checklist: "For any new data flow that creates/upserts rows, verify the proposal against existing unique indexes and constraints in `src/db/schema.ts`. If the design assumes multiple rows for the same key, the schema must change or the design must handle collisions explicitly."

### F2: Contradictory ordering behavior (appended vs sorted by score)
**What was caught:** Design section said diversity picks are "appended" while integration tests said they're "intermixed sorted by score" — two different observable behaviors.
**Why I missed it:** Used "appended" to describe the generation-time mechanism but carried the same word into the test plan where it described query-time API behavior. Didn't cross-check against the existing `orderBy(desc(suggestions.score))`.
**Prompt fix:** Add to /spec Test Plan validation: "For each test assertion, verify it describes the observable behavior at the correct layer (generation, persistence, or query). Cross-check against existing API sort/filter behavior in the routes and service methods."

### F3: Vague enum extension surface, references non-existent shared type
**What was caught:** Spec said add to "schema, shared types, client type" but no shared discover type exists, and the actual surface spans 8 files.
**Why I missed it:** Assumed a shared type existed without grepping. Didn't enumerate the full caller surface — just gestured at categories of files.
**Prompt fix:** Add to /spec Scope Boundaries checklist: "For enum/type extensions, grep the codebase for all current usages of the existing literals and produce an explicit file-by-file touch list. Do not assume shared types exist — verify under `src/shared/`."

### F4: Understated fixture blast radius
**What was caught:** Blast radius only called out `getStrengthForReason()` and client row type, missing 4 test files and most source files.
**Why I missed it:** Wrote blast radius as afterthought instead of systematically grepping for literal usages.
**Prompt fix:** Add to /spec Fixture Blast Radius: "Grep for the exact literals being extended in both `src/` and test files (`*.test.ts`). List every file with what kind of change is needed (enum update, fixture update, new test case, filter option)."
