---
skill: respond-to-pr-review
issue: 342
pr: 344
round: 1
date: 2026-03-11
fixed_findings: [F1]
---

### F1: Positioning tests assert "changed" not "correct"
**What was caught:** The new portal positioning tests only verified that `style.top` changed on scroll/resize (not what it changed to) and that the clamped `left` was `<=` a bound (not equal to the expected value). This means the right-aligned/below-trigger contract could regress without failing the suite.
**Why I missed it:** I was focused on proving the portal mechanism works (renders to body, repositions on events, clamps at edges) rather than proving the positioning math is correct. The tests proved "something happens" not "the right thing happens." The self-review step also didn't catch this because it evaluated AC coverage at the feature level, not assertion precision.
**Prompt fix:** Add to `/implement` phase 3 step 4a (RED phase): "When testing computed values (positions, sizes, derived state), assert the exact output for a known input — not just that the output changed or is within a range. If the function is pure/deterministic, the test should be too."
