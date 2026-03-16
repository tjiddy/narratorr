---
scope: [scope/frontend]
files: [src/client/pages/activity/EventHistorySection.test.tsx]
issue: 389
source: review
date: 2026-03-15
---
The "Clear Errors" confirmation path had distinct modal text and a two-step chained deletion flow (download_failed → import_failed via onSuccess), but only "Clear All" was tested.

Missed because: Clear All and Clear Errors share the same ConfirmModal component, so testing one felt sufficient. But they have different modal messages and Clear Errors has a unique chained-mutation flow that Clear All doesn't.

Prevention: when a component has multiple confirmation actions with distinct behavior (different modal text, different mutation args, chained callbacks), each one needs its own test — shared UI doesn't mean shared behavior.
