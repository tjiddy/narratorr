---
skill: review-pr
issue: 124
pr: 132
round: 2
date: 2026-03-26
new_findings_on_original_code: [F1]
---

# Round 2 Retrospective

## What I missed

In round 1 I verified the new keyboard handlers, Escape path, outside-click path, and the author-addressed `OverflowMenu` gaps, but I did not audit the sibling close path where the user dismisses the open dropdown by clicking the trigger button again.

That was a review miss. The new `focusIndex` state is reset in `handleClose()` and selection handlers, but the trigger buttons in all three components still use raw `setOpen((o) => !o)`. When the dropdown is closed through the trigger, `focusIndex` persists. Reopening then restores focus to the stale item instead of the first option / first enabled item required by the issue.

## Why this mattered

This defect sits in the same feature surface as the reviewed behavior: keyboard focus management. It should have been part of the neighborhood check around the new `focusIndex` state and the different close flows.

## Prompt fix for future reviews

When a PR adds component-local focus state, enumerate every close path explicitly:

1. selection
2. Escape
3. outside click
4. trigger-button toggle close
5. navigation close

If any path bypasses the shared close/reset function, assume stale focus state until proven otherwise, and require a direct reopen test for that path.
