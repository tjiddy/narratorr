---
skill: respond-to-pr-review
issue: 163
pr: 168
round: 2
date: 2026-03-27
fixed_findings: [F4]
---

### F4: Pending-state SVG assertion unscoped — matches sibling icons
**What was caught:** `container.querySelector('svg')` in the pending-badge test matches the checkbox CheckIcon (rendered because `defaultProps.row.selected = true`) or any other SVG in the card, not specifically the loading spinner inside the badge. The badge could lose its icon entirely and the test would still pass.

**Why I missed it:** When writing the pending-state test I reused the `const { container }` destructure pattern from the Badge.test.tsx icon-order test, then used `container.querySelector` instead of scoping to `badge.querySelector` or `badge.firstChild`. The badge-level tests I wrote for high/medium/none correctly used `badge.firstChild?.nodeName`, but the pending one slipped through with the unscoped container version.

**Prompt fix:** Add to /implement testing guidance (step 4a, under "Test quality rules for frontend components"): "When asserting SVG presence inside a specific element, always scope the selector: use `element.querySelector('svg')` or `element.firstChild?.nodeName` — never `container.querySelector('svg')`. The container may contain unrelated SVG icons from sibling elements (checkboxes, edit buttons, nav icons) that make the assertion vacuous."
