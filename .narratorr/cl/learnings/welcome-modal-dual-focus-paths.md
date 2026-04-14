---
scope: [frontend]
files: [src/client/components/WelcomeModal.tsx, src/client/components/WelcomeModal.test.tsx]
issue: 551
date: 2026-04-14
---
WelcomeModal has two distinct initial-focus paths: non-pending (focus from useFocusTrap stays on Modal panel) and pending (isPending useEffect refocuses inner dialog wrapper). When updating focus tests, these must be treated as separate test cases with different expected outcomes. The duplicate focus test at line 359 was easy to miss — always grep the full test file for assertions on `document.activeElement` when changing focus behavior.
