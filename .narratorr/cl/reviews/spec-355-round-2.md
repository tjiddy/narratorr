---
skill: respond-to-spec-review
issue: 355
round: 2
date: 2026-03-13
fixed_findings: [F1]
---

### F1: limit=500 transition still truncates full-list UIs
**What was caught:** The `limit=500` transitional strategy is just a bigger silent truncation — event history already grows to thousands, and library/activity pages derive counts and filters from the full dataset.
**Why I missed it:** Treated the reviewer's F1 from round 1 as "pick a bigger number" rather than recognizing the fundamental issue: any default limit breaks full-list semantics. The fix should have been "make pagination opt-in, not opt-out."
**Prompt fix:** Add to `/respond-to-spec-review` step 5 decision logic: "When a finding identifies a correctness problem (not just a preference), verify the fix actually eliminates the root cause. If the fix is 'same thing but bigger/smaller threshold,' it probably doesn't. Ask: does this fix preserve correctness for all existing consumers, or just delay the breakage?"
