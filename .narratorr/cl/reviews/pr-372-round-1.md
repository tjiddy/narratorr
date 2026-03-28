---
skill: respond-to-pr-review
issue: 372
pr: 396
round: 1
date: 2026-03-16
fixed_findings: [F1, F2, F3, F4]
---

### F1: useLibrary() full-library callers regression
**What was caught:** `useLibrary()` now returns only the first 100 books, breaking BookEditModal and AuthorPage duplicate detection for libraries >100 books.
**Why I missed it:** The explore step identified these files in the blast radius but I only checked that the hook's API contract was correct for the primary consumer (LibraryPage). I didn't verify that the shared hook's non-paginated callers still worked correctly after the default limit was enforced.
**Prompt fix:** Add to `/implement` step 4d (sibling enumeration): "When changing a shared hook's default behavior (e.g., adding default limits, changing return shape), grep for ALL callers of that hook and verify each caller's assumptions still hold. Non-primary callers are the most likely to break silently."

### F2: Title sort strips articles from anywhere
**What was caught:** SQL REPLACE() on the whole title string removed interior articles, changing sort order for titles like "Name of the Wolf".
**Why I missed it:** I wrote the SQL from scratch instead of checking the existing `toSortTitle()` in `naming.ts` for reference semantics. The explore step didn't highlight this existing utility.
**Prompt fix:** Add to `/plan` step 3 explore prompt: "When implementing server-side equivalents of existing client-side logic (sort, search, filter), find and name the existing client-side implementation so the implementer can match its semantics."

### F3: createdAt sort ignores direction param
**What was caught:** The default/createdAt case in `buildOrderBy()` hardcoded `desc()` instead of using the computed `dir` variable.
**Why I missed it:** The default case felt like "just the fallback" and I didn't test it with `sortDirection=asc`. Every sort field should be tested with both directions.
**Prompt fix:** Add to test quality standards: "When implementing parameterized behavior (sort direction, filter modes), test all parameter combinations — especially the default case, which is often hardcoded by mistake."

### F4: Pagination doesn't clamp on total shrink
**What was caught:** No mechanism to snap back to a valid page when total shrinks below the current page.
**Why I missed it:** The spec's edge case section mentions "Navigating to a page that becomes invalid after deletion" but I didn't implement it. I focused on the happy path pagination flow.
**Prompt fix:** Add to `/implement` step 4a (test depth rule): "For pagination hooks, always test: page clamping when total shrinks, empty state (total=0), and boundary transition (total goes from multi-page to single-page)."
