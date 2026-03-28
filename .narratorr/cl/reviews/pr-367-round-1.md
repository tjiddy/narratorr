---
skill: respond-to-pr-review
issue: 367
pr: 415
round: 1
date: 2026-03-16
fixed_findings: [F1, F2, F3, F4, F5, F6, F7, F8]
---

### F1: No-suggestions branch drops page header affordances
**What was caught:** The empty-suggestions branch returned early without the PageHeader, so users had no Refresh button despite the copy saying "hit Refresh".
**Why I missed it:** Focused on the main happy path and didn't trace the empty-state copy back to verify the referenced action was actually rendered in that branch.
**Prompt fix:** Add to `/implement` frontend checklist: "For every empty state that references an action (e.g., 'hit Refresh', 'add books'), verify the action UI is rendered in that same branch."

### F2: Missing /discover route test
**What was caught:** New route in App.tsx had no corresponding route-wiring test.
**Why I missed it:** Didn't check the existing App.test.tsx pattern when adding the route — assumed page-level tests were sufficient.
**Prompt fix:** Add to `/plan` step for frontend routes: "When adding a new route to App.tsx, add a route-level test in App.test.tsx that renders the app at the new path and asserts the page component appears."

### F3: Nav ordering not tested
**What was caught:** Tests checked show/hide but not insertion order (Discover between Search and Activity).
**Why I missed it:** Thought presence tests were sufficient for nav integration. Didn't consider that ordering is part of the AC.
**Prompt fix:** Add to `/implement` frontend nav changes: "When adding conditional nav items, test both presence AND ordering of all nav labels using `getAllByRole('link').map(textContent)`."

### F4/F5: Mutation optimistic UI untested
**What was caught:** Add/dismiss tests only asserted API call and error toast, not optimistic removal, restore on failure, or success toast.
**Why I missed it:** Wrote tests for the contract (API called with right args) but not the UX contract (card disappears/reappears). Didn't use deferred promises to test intermediate state.
**Prompt fix:** Add to testing.md mutation testing section: "For mutations with optimistic UI, use deferred promises to assert the intermediate state (element hidden while pending). Always test: (1) element disappears on mutate, (2) element reappears on rejection, (3) success toast/side effects on resolve."

### F6: Refresh success/failure consequences untested
**What was caught:** Refresh test only checked click + spinner, not success consequences (clears removedIds, toast) or failure (error toast).
**Why I missed it:** Stopped at "proves the button works" without following through to "proves the mutation's onSuccess/onError callbacks fire correctly".
**Prompt fix:** Add to testing.md: "Every mutation test must cover the full lifecycle: trigger → pending state → resolve → success consequences AND trigger → pending → reject → error consequences."

### F7: Settings validation bounds incomplete
**What was caught:** Only tested intervalHours=0, missed maxSuggestionsPerAuthor min/max bounds.
**Why I missed it:** Wrote one validation test and considered the pattern proven, without checking all validated fields.
**Prompt fix:** Add to testing.md Zod validation section: "For every field with min/max bounds in a Zod form schema, test both boundary violations (below min, above max) and assert the mutation is NOT called."

### F8: Settings save consequences untested
**What was caught:** Save tests only asserted updateSettings was called, not success (toast, dirty reset) or failure (error toast).
**Why I missed it:** Same pattern as F4/F5 — tested the invocation but not the side effects.
**Prompt fix:** Same as F6 — the mutation lifecycle rule covers this case. Add to testing.md: "For form save mutations, additionally assert: success → toast + form resets to clean state (save button disappears); failure → error toast with message."
