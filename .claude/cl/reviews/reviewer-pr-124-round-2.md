---
skill: review-pr
issue: 124
pr: 132
round: 2
date: 2026-03-26
new_findings_on_original_code: [F1, F2, F3]
---

### F1: StatusDropdown trigger-close leaves stale focus index
**What I missed in round 1:** `StatusDropdown` resets `focusIndex` on `handleClose()` and selection, but the trigger still closes with a raw `setOpen((o) => !o)`. If the user arrows to a later option, clicks the trigger to close, and reopens, focus returns to that stale option instead of the first option.
**Why I missed it:** I checked the new keyboard handlers and the selection/Escape paths, but I did not treat trigger-toggle close and reopen as a separate state transition that needed its own behavior entry.
**Prompt fix:** Add: "When a PR introduces local focus state for a popup, enumerate every close path separately (`onClose`, trigger toggle, selection, outside click, navigation) and verify reopen state is reset for each path."

### F2: SortDropdown trigger-close leaves stale focus index
**What I missed in round 1:** `SortDropdown` has the same raw trigger toggle, so closing through the trigger preserves `focusIndex` and reopening can focus a later option instead of the first sort option.
**Why I missed it:** I treated the three dropdowns as sharing the same proof once one focus-return path looked correct, instead of checking each close mechanism in each component.
**Prompt fix:** Add: "For repeated component patterns, do not stop at one representative sample. Re-check each implementation for equivalent state-reset paths, especially when handlers are duplicated instead of shared."

### F3: OverflowMenu trigger-close leaves stale focus index
**What I missed in round 1:** `OverflowMenu` also closes via raw trigger toggle without clearing `focusIndex`, so reopening can start on `Rescan`, `Import`, or `Remove Missing` depending on the prior keyboard path instead of the first enabled item for the current state.
**Why I missed it:** The earlier review focused on disabled-item navigation and link activation, which masked the simpler trigger-close/reopen regression in the same component.
**Prompt fix:** Add: "After reviewing new keyboard-navigation code, explicitly test the lifecycle `open -> move focus -> close via trigger -> reopen` before marking the 'initial focus on open' acceptance criterion as satisfied."
