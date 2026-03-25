---
skill: respond-to-pr-review
issue: 98
pr: 101
round: 2
date: 2026-03-25
fixed_findings: [F1, F2]
---

### F1: Missing active-state styling across all interactive elements
**What was caught:** No `active:` CSS modifier appeared anywhere in PathStep.tsx despite AC2 explicitly requiring hover, focus, AND active states to be polished.
**Why I missed it:** Focused on matching the hover patterns from SearchBookCard/SuggestionCard, which don't use `active:` either. No sibling prior art to look at, and I didn't re-read the AC word-for-word during the implementation step to verify all three state types were addressed.
**Prompt fix:** Add to `/implement` step 4b (Green phase): "After implementing UI state changes, re-read each AC item literally. If an AC names multiple CSS states (e.g., 'hover, focus, and active'), grep the changed file for each state modifier (`hover:`, `focus`, `active:`) and verify all are present. If any named state has zero matches, it's an open gap."

### F2: Favorited-heart hover color inverts visual hierarchy
**What was caught:** `text-primary hover:text-primary/80` dimmed the favorited heart on hover, making it less visually prominent than the unfavorited heart's `hover:text-primary`. The spec required the favorited state to remain more emphasized.
**Why I missed it:** Added hover class in isolation without comparing the favorited+hover state against the unfavorited+hover state side by side. The hover was added as a "softening" tweak without realizing it inverted the hierarchy relative to the paired button.
**Prompt fix:** Add to `/implement` step 4 (pattern for paired buttons): "When two controls represent opposite states (on/off, favorited/unfavorited), verify visual hierarchy is consistent at every interaction state: rest, hover, active, focus. The 'on' state must always appear more emphasized than the 'off' state at the same interaction level. Check both by writing out the computed effect: `text-primary hover:text-primary/80` = dims on hover; `hover:text-primary` = brightens on hover → inverted hierarchy on hover."
