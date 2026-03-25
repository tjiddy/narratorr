---
skill: respond-to-pr-review
issue: 106
pr: 116
round: 1
date: 2026-03-25
fixed_findings: [F1, F2]
---

### F1: Missing positioning/repositioning tests for ToolbarDropdown
**What was caught:** The shared `ToolbarDropdown` component's core positioning logic (computing `top`/`left` from `getBoundingClientRect`, recomputing on scroll/resize) had zero test coverage. Any regression in `computePosition()` or the event-listener wiring would be invisible.

**Why I missed it:** Tests were written behavior-first (open/close/keyboard/outside-click) without asking "what other observable effects does this component produce?" The inline style values on the portal wrapper are a distinct observable output that deserved its own assertions. I mentally categorized `getBoundingClientRect` as an implementation detail rather than a contract boundary.

**Prompt fix:** Add to /implement step for shared utility components: "If a component computes inline `style` values from DOM measurements (e.g., `getBoundingClientRect`, `offsetWidth`), add a dedicated test that stubs the measurement and asserts the resulting style attribute values. Also assert that any global event listeners (`scroll`, `resize`) trigger recomputation by dispatching the event inside `act()` and checking style updates."

### F2: Missing toolbar layout contract tests
**What was caught:** The search-first/overflow-last composition and the `min-w-[200px]` contract — the primary UX goal of the issue — were implemented but not pinned by any test. A future refactor could silently reintroduce the old crowded layout.

**Why I missed it:** Tests were organized around individual controls rather than the overall composition. I wrote "does StatusDropdown exist?" tests but not "is the layout correct?" tests. The spec's primary deliverable was the layout change, but I treated it as implicit rather than testable.

**Prompt fix:** Add to /plan's test planning step: "When the spec's primary change is a layout or composition change (reordering controls, adding wrappers, changing layout constraints), include at least one test that asserts the overall DOM structure — child order, container class contracts (e.g., min-width), or relative positioning of key controls. These are first-class behavioral contracts, not styling details."
