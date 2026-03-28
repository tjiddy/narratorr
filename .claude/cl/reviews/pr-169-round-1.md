---
skill: respond-to-pr-review
issue: 169
pr: 171
round: 1
date: 2026-03-28
fixed_findings: [F1]
---

### F1: isPending focus regression after div→link conversion

**What was caught:** After converting `InfoCard` from `<div>` to `<a href>`, `useFocusTrap` now focuses the first card link when `isPending=true` instead of the dialog container. The original regression guard (from the issue spec) was silently broken.

**Why I missed it:** The test was updated to reflect the new observed behavior (first link focused) rather than checking the *intended* behavior (dialog container focused). Tabbable element changes were noted in implementation learnings but the isPending focus useEffect was not added at that point — only the focus-trap tab order tests were updated. The regression guard was never verified to still hold.

**Prompt fix:** When changing DOM elements from non-tabbable to tabbable (or vice versa), explicitly re-run every focus-related test before calling the implementation complete. Any test that previously asserted "focuses element X" must be re-read and verified against the *spec intent*, not just the *current behavior*. Specifically, if the spec says "isPending locks focus to container", the test must always assert the container — not whichever element happens to receive focus at render time.
