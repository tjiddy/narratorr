---
skill: respond-to-pr-review
issue: 124
pr: 132
round: 1
date: 2026-03-26
fixed_findings: [F1, F2, F3]
---

### F1: Enter-on-Import test asserts closure not navigation
**What was caught:** The keyboard Enter test for the Import router link only checked that the menu closed. This would pass even if the keyboard handler called setOpen(false) directly without triggering navigation.

**Why I missed it:** The reasoning was transitive: "Enter calls click(); click() calls setOpen(false); menu closes → Enter works." The closure is a proxy for click, but a weak one — any other dismiss path would also close the menu. I didn't ask "what's the actual behavior I'm proving?"

**Prompt fix:** Add to /plan step 3 under "Test quality" or to CLAUDE.md Gotchas: "When testing router-link keyboard activation, assert the navigation outcome (location changes to target path) not closure behavior. Closure is a side-effect that proves nothing about whether navigation fired."

### F2: Navigation not exercised in both-disabled-leading focusable set
**What was caught:** The test for the both-disabled state only checked initial focus (Import is focused on open). No test navigated ArrowDown/ArrowUp among the remaining enabled items (Import + Remove Missing).

**Why I missed it:** The initial-focus test was the spec's most visible requirement for that state. I treated "first item correct on open" as sufficient proof of the dynamic focusable-item logic working. Navigation through the set was a separate behavior I didn't decompose.

**Prompt fix:** Add to /plan test-stubs generation: "For keyboard-navigable menus with state-dependent disabled items, create stubs for: (a) initial focus per disabled-state combo, AND (b) ArrowDown+ArrowUp roundtrip for each distinct focusable-item subset."

### F3: Outside-click path untested after shared handleClose() broadened its scope
**What was caught:** Using handleClose() as the ToolbarDropdown onClose handler meant outside-click dismissal also restored focus — broader than the spec. This path had no test; the existing outside-click test only checked the menu closed.

**Why I missed it:** Correct behavior (ARIA says return focus on dismiss) + natural code placement → no flag raised that the behavior was out-of-spec scope. "It's the right thing to do" displaced "is it specified?"

**Prompt fix:** Add to CLAUDE.md or /implement: "When a dismiss handler is wired to multiple close paths (Escape, outside-click, selection), test each path explicitly. Note any behaviors added beyond the issue spec as 'intentional additions' in the PR summary so reviewers can assess scope."
