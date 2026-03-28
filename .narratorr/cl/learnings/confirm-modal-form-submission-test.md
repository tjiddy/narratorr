---
scope: [frontend]
files: [src/client/components/ConfirmModal.tsx, src/client/components/ConfirmModal.test.tsx]
issue: 83
date: 2026-03-25
---
For button `type="button"` fixes, a DOM attribute assertion alone is weaker than a behavior test. Wrap the component in a `<form onSubmit={vi.fn()}>` and assert that clicking each button does NOT call `onSubmit`. This proves the browser doesn't treat the button as a submit trigger, not just that the attribute string is present in the DOM. Reviewer F2 in spec review #83 flagged this pattern.
