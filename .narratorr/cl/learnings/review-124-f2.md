---
scope: [scope/frontend, scope/ui]
files: [src/client/pages/library/OverflowMenu.test.tsx]
issue: 124
source: review
date: 2026-03-26
---
The reviewer caught that while the initial-focus test for the both-disabled state existed (verifying Import is focused on open), no test exercised ArrowDown/ArrowUp navigation in that state. The spec required that navigation wraps among remaining enabled items — but a bug in the querySelectorAll list or wrap math would still pass the suite.

Why we missed it: The initial-focus test felt like it proved the both-disabled path was working. But "first item is correct on open" and "navigation wraps correctly among those items" are two separate behaviors. We tested the entry condition but not the navigation through the resulting focusable set.

What would have prevented it: When the focusable item set is state-dependent (items disabled/enabled based on props), each distinct set needs its own navigation roundtrip test — not just initial-focus. The test plan should explicitly call out: for each distinct disabled-item combination, test open-focus + ArrowDown + ArrowUp wrapping.
