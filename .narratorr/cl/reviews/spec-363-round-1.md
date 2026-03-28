---
skill: respond-to-spec-review
issue: 363
round: 1
date: 2026-03-14
fixed_findings: [F1, F2, F3, F4]
---

### F1: FilterRow empty-options boundary test contradicts component contract
**What was caught:** Test plan asserted accessible labels on FilterRow selects when option lists are empty, but FilterRow hides selects entirely when below threshold.
**Why I missed it:** The `/elaborate` subagent correctly identified the conditional rendering but the test plan boundary cases were written generically without cross-referencing which DOM elements actually exist in each state.
**Prompt fix:** Add to `/elaborate` step 4 test plan gap-fill: "For every boundary/edge-case test, verify the target DOM element is rendered in the proposed scenario by checking conditional rendering guards in the source. If the element is conditionally hidden, the test case is invalid."

### F2: Tab keyboard AC ambiguous on activation model
**What was caught:** "Navigate between tabs" doesn't specify whether arrow keys only move focus or also activate the tab (swap panel, update aria-selected).
**Why I missed it:** Treated tab keyboard navigation as a single concept rather than recognizing that WAI-ARIA defines two distinct activation models (automatic vs manual) with different implementation and testing implications.
**Prompt fix:** Add to `/elaborate` step 4 (or `/spec` AC checklist): "For ARIA widget patterns (tabs, menus, comboboxes, trees, accordions), explicitly name the activation/interaction model per WAI-ARIA Authoring Practices. Ambiguous verbs like 'navigate' or 'select' are insufficient."

### F3: Generic icon references instead of shared wrappers
**What was caught:** AC said "Lucide icon (e.g., Headphones)" when `HeadphonesIcon` and `PackageIcon` already exist in `@/components/icons`.
**Why I missed it:** Subagent found the wrappers and reported them in ephemeral codebase findings, but I wrote the AC with generic names instead of propagating the specific wrapper names into the durable AC text.
**Prompt fix:** Add to `/elaborate` step 4 durable content rules: "When the subagent identifies existing shared abstractions (wrappers, helpers, registries) that the AC references, use the exact names from the codebase in the AC text, not generic library names."

### F4: Icon replacement missing decorative treatment
**What was caught:** Replacing emoji with SVG icons without `aria-hidden="true"` would add redundant screen reader announcements alongside existing text.
**Why I missed it:** Focused on visual consistency (emoji → icon) without considering the ARIA implications of the swap. Especially ironic on an accessibility-focused issue.
**Prompt fix:** Add to `/elaborate` DEFECT VECTORS analysis (step 10): "When replacing presentational elements (emoji, images, icons), determine ARIA treatment: decorative → `aria-hidden='true'`, meaningful → needs `aria-label`. Flag if not specified in the AC."
