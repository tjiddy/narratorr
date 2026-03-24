---
scope: [frontend, ui]
files: [src/client/components/AddBookPopover.test.tsx]
issue: 342
source: review
date: 2026-03-11
---
Positioning tests only asserted that style.top changed (not what it changed TO) and that left was <= a bound (not equal to the expected value). When testing computed positioning logic, always assert the exact output coordinates — "it moved" doesn't prove "it moved correctly." The computePosition function is deterministic and pure, so exact assertions are trivial to write by computing the expected values from the mocked input rect.
