---
scope: [scope/frontend, scope/ui]
files: [src/client/components/layout/Layout.tsx, src/client/components/layout/Layout.test.tsx]
issue: 108
source: review
date: 2026-03-25
---
When a nav bar control is removed, the updated tests verified the control's absence and the remaining links' ordering — but not the positional contract of the control that now closes the nav (HealthIndicator must follow Settings and be the final interactive element). The reviewer caught that two assertions would still pass even if HealthIndicator were moved before the links or a new control were added after it.

**What was caught:** Tests asserted nav link order and that HealthIndicator renders somewhere, but didn't pin HealthIndicator's position relative to the Settings link or assert it is the last interactive nav control.

**Why we missed it:** The test plan focused on link order (the thing being preserved) and toggle removal (the change being made), but didn't think through the full "trailing control" contract that HealthIndicator implicitly holds after the removal.

**What would have prevented it:** When removing a nav control, enumerate what structural invariants the removed element was implicitly enforcing. For any element that closes a container (e.g., "the last control in nav"), add a positional assertion: locate the preceding anchor and the closing element, use `compareDocumentPosition` to verify order, and assert the closing element is last via `querySelectorAll('a, button')` on the parent.
