---
skill: respond-to-pr-review
issue: 159
pr: 160
round: 1
date: 2026-03-27
fixed_findings: [F1, F2]
---

### F1: Warning badge using semantic tokens instead of concrete red colors
**What was caught:** The `WarningBadge` component used `bg-destructive text-destructive-foreground` instead of the explicit `bg-red-500 text-white` required by issue #159 AC5.
**Why I missed it:** The badge already existed in the component and rendered visually as red via the destructive token. I didn't compare the existing classes against the spec's concrete color requirement. The AC said "must use `bg-red-500 text-white rounded-full`" as a literal pass/fail check but I treated the existing semantic token as equivalent.
**Prompt fix:** Add to `/implement` design polish step: "For any visual AC that specifies literal CSS classes (e.g., `bg-red-500 text-white`), diff the existing class list against the spec requirement character-by-character — do not assume semantic tokens are equivalent to concrete color values."

### F2: Missing backdrop click non-dismiss regression test
**What was caught:** The test plan explicitly listed "clicking backdrop does not dismiss" as a required test, but no test was written for it.
**Why I missed it:** I systematically wrote tests for each AC (scroll lock, focus trap, Escape block) but the backdrop click was listed in the test plan as a behavioral assertion without a corresponding AC bullet. I missed mapping it to a test case during implementation.
**Prompt fix:** Add to `/implement` test checklist: "Before marking tests complete, verify each item in the issue's test plan has a corresponding `it(...)` block — not just the acceptance criteria bullets. Test plan items and ACs are separate; both must be covered."
