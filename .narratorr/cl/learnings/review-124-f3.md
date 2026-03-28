---
scope: [scope/frontend, scope/ui]
files: [src/client/pages/library/OverflowMenu.tsx, src/client/pages/library/StatusDropdown.tsx, src/client/pages/library/SortDropdown.tsx]
issue: 124
source: review
date: 2026-03-26
---
Passing handleClose() as the ToolbarDropdown onClose handler caused outside-click dismissal to also restore focus to the trigger — a slightly broader behavior than the issue spec required (which only called out selection and Escape). This path was untested and went unnoticed because the existing outside-click test only verified the menu closes.

Why we missed it: The onClose prop is a natural place to put cleanup logic, and focus restoration is correct ARIA behavior. But "natural placement" != "specified behavior" — the issue spec scoped focus return to selection/Escape, and we silently extended it to outside-click without noting it or adding a test.

What would have prevented it: When a shared handler is reused for multiple dismiss paths (Escape, outside-click, programmatic close), explicitly verify each path is tested. For outside-click focus tests, use fireEvent.mouseDown() directly rather than userEvent.click() on a non-interactive element — user-event's focus management before the pointer events interferes with JSDOM's focus tracking in this scenario.
