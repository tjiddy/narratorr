---
scope: [frontend]
files: [src/client/components/ConfirmModal.test.tsx, src/client/components/Modal.tsx]
issue: 551
source: review
date: 2026-04-14
---
When adding behavior to a shared component (Modal focus trap), the spec explicitly called for consumer regression tests (ConfirmModal) but implementation only covered Modal-level tests. The gap: treating "existing consumer tests pass" as sufficient regression coverage. Consumer-level tests that exercise the specific interaction (useEscapeKey autofocus → initial focus on inner dialog, Tab cycling within consumer controls) are needed to prove coexistence. Always add at least one consumer-level interaction test when changing shared component behavior.
