---
scope: [scope/frontend, scope/ui]
files: [src/client/components/AddBookPopover.tsx]
issue: 342
source: spec-review
date: 2026-03-11
---
Spec treated scroll/resize repositioning as optional ("if viewport-aware positioning is added") even though portaling to `document.body` makes position drift a guaranteed defect. When an implementation changes the positioning model (relative→portal), all the behaviors that the old model handled implicitly (anchoring, viewport tracking) must become explicit requirements.
