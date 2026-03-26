---
skill: respond-to-pr-review
issue: 139
pr: 140
round: 1
date: 2026-03-26
fixed_findings: [F1, F2]
---

### F1: Selected duplicate rows still dimmed via opacity-50 fallback
**What was caught:** The ternary `(isDuplicate && !row.selected) ? 'opacity-60' : (!confidence ? 'opacity-50' : '')` leaves selected duplicates hitting the `!confidence` fallback, applying `opacity-50` — since duplicate rows have no matchResult.
**Why I missed it:** I focused on removing `opacity-60` for the selected case without tracing what the fallback branch would now apply. The multi-clause ternary made it easy to only reason about the changed branch.
**Prompt fix:** Add to `/implement` step 4b (sibling enumeration): "For conditional class assignments, enumerate ALL branches and verify each is reachable only under its intended conditions. When a condition is added to a ternary, explicitly trace what the fallback branch now applies to."

### F2: Test only checked absence of opacity-60, not opacity-50
**What was caught:** The regression test for "selected duplicate not dimmed" only asserted `not.toContain('opacity-60')`, allowing `opacity-50` to pass silently.
**Why I missed it:** I wrote the test against the specific class being removed (opacity-60) rather than against the broader UX contract (no dimming at all). The spec said "not dimmed" but I tested "not opacity-60".
**Prompt fix:** Add to CLAUDE.md § Code Style: "When testing 'element is undimmed/unaffected', assert the absence of ALL dim/state classes, not just the one changed. Map spec language ('not dimmed') to its full CSS representation before writing assertions."
