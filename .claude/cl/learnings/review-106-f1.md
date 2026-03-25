---
scope: [scope/frontend, scope/ui]
files: [src/client/components/ToolbarDropdown.tsx, src/client/components/ToolbarDropdown.test.tsx]
issue: 106
source: review
date: 2026-03-25
---
Reviewer caught that the shared `ToolbarDropdown` positioning logic (computing top/left from trigger `getBoundingClientRect`, and recomputing on scroll/resize) had no test coverage. The existing tests only covered portal mounting and close behavior. The positioning is a core behavioral contract — if `computePosition()` or the scroll/resize listener wiring regressed, all three toolbar menus would render detached from their triggers while the test suite stayed green.

Why missed: The implementation focused on testing observable user behaviors (open/close, keyboard, outside-click) and overlooked the positioning mechanics as a separate testable concern. The scroll/resize re-computation path, in particular, is invisible to presence-only tests.

What would have prevented it: A prompt reminder to test computed DOM properties (style values) when a component uses `getBoundingClientRect` or adds global event listeners — these are the implementation paths most likely to regress silently.
