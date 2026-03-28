---
scope: [frontend]
files: [src/client/components/Modal.tsx]
issue: 161
date: 2026-03-28
---
React event handler props set to `undefined` are silently ignored — no TypeError is thrown when clicked. `onClick={onClose}` when `onClose` is `undefined` is a safe no-op. A self-review subagent incorrectly flagged this as a crash bug; the existing test "does not throw when backdrop is clicked and onClose is not provided" confirms the safety. Knowing this upfront would have avoided a false-fail review loop.
