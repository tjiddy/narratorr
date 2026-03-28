---
skill: respond-to-spec-review
issue: 372
round: 2
date: 2026-03-15
fixed_findings: [F8, F9, F10, F11, F12]
---

### F8: Global action counts not covered by stats endpoint
**What was caught:** missingCount/wantedCount for Remove Missing button and Search Wanted confirmation derive from full books array, but the stats endpoint only covered tab counts and filter dropdowns.
**Why I missed it:** Only traced the "obvious" consumers of the full array (tab counts, filter dropdowns) without checking ALL components that derive values from the books array. LibraryActions was a separate component.
**Prompt fix:** Add to `/elaborate` Explore subagent deep source analysis: "When paginating a list, grep for ALL references to the unpaginated data variable (e.g., `books`) across the page and child components. Every derivation becomes either stale or wrong under pagination."

### F9: Search behavior change not documented as intentional
**What was caught:** Fuse fuzzy search → SQL LIKE is a behavior regression. Also missed genres in search fields.
**Why I missed it:** Focused on the architectural decision (search moves server-side) without documenting what behavior changes that implies. Didn't re-read the Fuse config to match search fields.
**Prompt fix:** Add to `/elaborate` step 4: "When the spec replaces a client-side feature with a server-side equivalent, document the behavior delta explicitly — what changes, what's preserved, and why the change is acceptable. Read the existing implementation's config to verify field/option parity."

### F10: Sort contract not enumerated
**What was caught:** Spec said "accepts sortField and sortDirection" without listing the 8 accepted values or their server-side semantics.
**Why I missed it:** Treated sort as a pass-through parameter without realizing server-side sort requires explicit computation definitions for derived fields.
**Prompt fix:** Add to `/elaborate` step 4: "When moving sort/filter logic server-side, enumerate every accepted value with its server-side computation. Computed fields (ratios, fallbacks, transformations) need explicit formulas. Null handling and secondary sort need explicit rules."

### F11: Bulk actions scope change not addressed
**What was caught:** Bulk actions silently narrow from full filtered set to current page under pagination.
**Why I missed it:** Focused on the data flow (hooks, API calls, query keys) and missed the UX-level implications for selection scope.
**Prompt fix:** Add to `/elaborate` Explore subagent: "Check for selection/bulk-action patterns on paginated lists. If the current implementation selects from the full dataset, pagination narrows that to page-scoped — this must be called out as intentional or addressed."

### F12: Event history search pagination reset missing
**What was caught:** Spec reset pagination on type filter change but not on search query change.
**Why I missed it:** Checked the type filter pills but didn't notice the search input on the same component.
**Prompt fix:** Add to `/elaborate` step 4 pagination reset rule: "When specifying pagination resets for filter changes, enumerate ALL inputs on the affected page that change the result set — not just the primary filter. Check for search inputs, secondary filters, and any other state that affects the query."
