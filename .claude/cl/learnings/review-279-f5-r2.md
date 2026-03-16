---
scope: [frontend]
files: [src/client/pages/settings/ScheduledTasks.test.tsx]
issue: 279
source: review
date: 2026-03-10
---
When a button has disabled={isPending} and a spinner swap during mutation, those UI states need a test that holds the mutation promise open (deferred resolve) and asserts the button is disabled before resolving. Tests that resolve immediately never observe the pending state.
