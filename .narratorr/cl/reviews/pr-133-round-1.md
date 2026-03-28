---
skill: respond-to-pr-review
issue: 133
pr: 136
round: 1
date: 2026-03-26
fixed_findings: [F1, F2, F3, F4, F5, F6, F7]
---

### F1: Match-job failure is silent; Register button re-enabled on error
**What was caught:** `useMatchJob.error` was never read by `useLibraryImport`. A failed match job silently dropped `isMatching` to false, re-enabling the Register button with unmatched books and no error UI.
**Why I missed it:** I added `error` to `useMatchJob` in a separate earlier module and returned it — but when wiring `useLibraryImport`, I only destructured `isMatching`, `startMatching`, `cancel` and `results`. The test for the Register button used `startMatchJob.mockRejectedValue` specifically to make `isMatching` go false, which (incorrectly) proved registration was accessible after failure.
**Prompt fix:** Add to `/implement` step "When consuming a hook that exposes `error`, verify the consumer reads it and surfaces it to the user; search for `const { ... } = useX()` and confirm `error` is in the destructuring and appears in the return/UI."

### F2: Passive duplicate count instead of interactive hide/show toggle
**What was caught:** Spec said "hidden by default with a clickable existing (hidden/shown) header control" but I rendered a static `<span>` count badge.
**Why I missed it:** I read the AC item and coded the count display first, then didn't re-check the "clickable" / "hidden/shown" language. The static badge satisfied the count requirement but missed the interaction.
**Prompt fix:** Add to `/plan` test extraction: "AC items containing 'hidden/shown', 'toggle', or 'click to reveal' require toggle state tests: default hidden, click → visible, click again → hidden."

### F3: Slug-duplicate recheck uses case-insensitive comparison
**What was caught:** Client used `.toLowerCase()` on both title sides; backend uses exact equality.
**Why I missed it:** I implemented the recheck intuitively ("a case change should unlock it") without reading the server's `findDuplicate()` or `scanDirectory()` logic. The spec said "editedTitle === lb.title" but I drifted to case-insensitive which "felt safer."
**Prompt fix:** Add to `/implement` "When implementing client-side recheck of a server constraint, read the server implementation first and copy the comparison precisely. If the spec provides an explicit code expression (`editedTitle === lb.title`), use it verbatim."

### F4: authorSlug not asserted at route boundary
**What was caught:** The route test was not updated when the service's return shape gained `authorSlug`.
**Why I missed it:** I added `authorSlug` to the service test and assumed "service test covers it." Route tests are a separate concern (HTTP serialization).
**Prompt fix:** Add to CLAUDE.md Gotchas: "When changing a service's return shape, update BOTH service tests AND route tests. Service tests cover business logic; route tests cover HTTP serialization. A field can be present in service output but stripped by the route schema."

### F5: No App-level test for new route
**What was caught:** New `/library-import` route had no App.test.tsx coverage.
**Why I missed it:** I added the route in App.tsx but didn't look at App.test.tsx to see the pattern of adding a mock + test case for each new route.
**Prompt fix:** Add to `/implement` checklist: "When adding a route to App.tsx, also add: (1) a vi.mock for the new page component, (2) a test case that renders the router at the new path and asserts the page testid appears."

### F6: Page-level test not updated when page gains new query
**What was caught:** LibraryPage.tsx gained a `getSettings` query to drive EmptyLibraryState CTA selection, but LibraryPage.test.tsx was not updated.
**Why I missed it:** I wrote EmptyLibraryState unit tests (which covered the CTA switching) and assumed they were sufficient. The page-level wiring test (verifying LibraryPage actually passes `hasLibraryPath` correctly) was a separate responsibility.
**Prompt fix:** Add to `/implement`: "When a page component adds a new `useQuery` whose result changes conditional rendering, the page test must: (1) mock the new api method, (2) add a test for each rendering branch the query drives."

### F7: registerLabel not applied in pending state
**What was caught:** `ImportSummaryBar` rendered `registerLabel` in idle state but hardcoded "Importing..." in pending state, making the override incomplete.
**Why I missed it:** I implemented the label override for the idle branch but didn't scan all other branches that render similar text. The pattern "apply override to every rendering branch" requires a conscious multi-branch audit.
**Prompt fix:** Add to CLAUDE.md Gotchas: "When adding a label/text override prop to a component, apply it to ALL branches that render that text — including loading/pending states. A prop that overrides idle text but not pending text produces inconsistent copy."
