---
skill: respond-to-pr-review
issue: 108
pr: 123
round: 2
date: 2026-03-25
fixed_findings: [F1]
---

### F1: HealthIndicator positional contract not asserted in nav tests

**What was caught:** After removing the theme toggle, the updated tests verified link order and toggle absence but didn't assert that HealthIndicator follows Settings and is the final interactive nav control. Two separate passing assertions (order of links, presence of indicator) left a gap where HealthIndicator could be repositioned without being caught.

**Why I missed it:** Test planning focused on the change (removal) and what to preserve (link order), but didn't enumerate the structural invariants that the removed element was implicitly enforcing. HealthIndicator being last-in-nav was an implicit contract that became explicit only after the removal.

**Prompt fix:** Add to /implement step 4 (for nav/header changes): "When removing a nav control, enumerate positional invariants held by remaining controls. For any element that closes a nav/toolbar, add a positional assertion: (1) `compareDocumentPosition` against the preceding anchor to prove ordering, and (2) `querySelectorAll('a, button')` on the parent to prove it is the final interactive element."
