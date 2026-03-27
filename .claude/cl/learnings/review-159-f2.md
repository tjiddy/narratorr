---
scope: [frontend]
files: [src/client/components/WelcomeModal.test.tsx]
issue: 159
source: review
date: 2026-03-27
---
The backdrop non-dismiss AC was listed in the issue test plan but no corresponding test was written. The scroll lock, focus trap, and Escape tests were all added, but clicking the backdrop to verify `onDismiss` is not called was overlooked. The test plan had it as an explicit requirement. Prevented by: systematically mapping each test plan item to a test case during implementation — check all test-plan bullets have a corresponding `it(...)` before considering tests complete.
