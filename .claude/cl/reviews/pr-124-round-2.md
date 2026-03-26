---
skill: respond-to-pr-review
issue: 124
pr: 132
round: 2
date: 2026-03-26
fixed_findings: [F1]
---

### F1: Trigger-button close bypasses focusIndex reset
**What was caught:** All three trigger buttons called `setOpen((o) => !o)` — the close path bypassed `handleClose()` and left `focusIndex` stale. Reopen would focus the previously-focused item instead of the first option.

**Why I missed it:** The trigger toggle was written before `handleClose()` existed and was never audited when the reset logic was added. Writing `handleClose()` for keyboard/selection close paths is a natural refactor, but it's easy to miss the trigger toggle as another close site.

**Prompt fix:** Add to /implement or CLAUDE.md under focus-management: "When adding a close/reset handler to a dropdown, grep for all `setOpen(false)` call sites in the component. Each one that bypasses the new handler is a potential stale-state bug. The trigger toggle is the most common missed case."
