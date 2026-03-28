---
skill: respond-to-pr-review
issue: 69
pr: 76
round: 1
date: 2026-03-24
fixed_findings: [F1, F2, F3]
---

### F1: No icon assertion for the PlusIcon nav item change
**What was caught:** The nav test only asserted the label text "Add Book" but not that PlusIcon renders instead of SearchIcon. A regression back to SearchIcon would not fail any test.

**Why I missed it:** I treated the icon swap as covered by the label assertion. Icons are separate DOM nodes from labels in the nav link — label correctness says nothing about icon correctness.

**Prompt fix:** Add to /implement step 4a: "For each AC item involving a non-textual UI change (icon swap, class rename, structural change), ask: can the old value silently return while all tests still pass? If yes, add a structural assertion — for SVG icons, check the icon-specific path `d` attribute and/or the absence of the old icon's distinctive element (e.g., `<circle>` for SearchIcon)."

### F2: Subtitle copy change was not positively asserted
**What was caught:** The subtitle paragraph text ("Search metadata providers to find audiobooks to add") was never asserted to exist. The test only checked headings for "Discover" language — the subtitle is a `<p>`, invisible to heading-role queries.

**Why I missed it:** The AC "no Discover language" was implemented as a negative assertion on headings, which is incomplete when the changed text is in a non-heading element.

**Prompt fix:** Add to /implement step 4a: "When an AC involves a copy change (not just removal), always write both a positive assertion for the new string AND a negative assertion for the old/forbidden string. If the element is not a heading role, use getByText() with the exact new string."

### F3: Ordering assertion was vacuous
**What was caught:** "Search input is the first interactive control" was tested by checking the input exists and its tagName is INPUT — this does not verify ordering at all.

**Why I missed it:** I wrote the test to match the spec's label but encoded a weaker contract. The distinction between "exists" and "is first" requires collecting DOM-ordered elements.

**Prompt fix:** Add to /implement step 4a: "When an AC says 'X is the first Y', the test MUST collect all Y in document order and assert index 0 is X. Use container.querySelectorAll(...) and Array.from(). An existence check is not an ordering check."
