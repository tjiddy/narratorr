---
skill: respond-to-pr-review
issue: 73
pr: 78
round: 1
date: 2026-03-24
fixed_findings: [F1, F2]
---

### F1: Discovery toggle slider markup not tested
**What was caught:** No test verified that the Discovery toggle's `enabled` checkbox uses the `sr-only peer` hidden-checkbox slider pattern. Existing tests only check label association and save mutation, which would still pass with a visible raw checkbox.
**Why I missed it:** During implementation I focused on "does the toggle work?" (behavior) rather than "is the toggle the right kind?" (markup contract). The AC said "uses sr-only peer pattern" but I translated that into functional tests only.
**Prompt fix:** Add to `/plan` step 5 (test stubs): "When an AC specifies a UI markup pattern (e.g., sr-only peer, slider toggle, specific class), add an explicit stub: `it.todo('renders <control> using <pattern> markup, not a visible raw input')` that asserts the element has the pattern's class AND the sibling visual element exists. Functional behavioral tests alone cannot guard markup-pattern ACs."

### F2: Keep Original toggle slider markup not tested
**What was caught:** Same gap as F1 — the compact slider variant conversion for keepOriginalBitrate had no test asserting the sr-only + track-div contract.
**Why I missed it:** Same root cause as F1. Additionally, I had existing disabled/opacity tests that gave false confidence that the toggle conversion was well-covered.
**Prompt fix:** Same fix as F1. Add to `/implement` step 4a (Red phase rule): "For any AC that replaces a visible input with a visually-hidden one (sr-only, hidden, display:none), the failing test must assert BOTH that the element has the hiding class AND that the visual replacement element exists as a sibling. A click test alone is not sufficient — the old element would pass it too."
