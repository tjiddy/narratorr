---
scope: [frontend]
files: [src/client/pages/settings/SecuritySettings.test.tsx]
issue: 512
source: review
date: 2026-04-12
---
When fixing a modal-stays-open-on-error bug, testing visibility alone is insufficient. The retry contract must also be tested: after the error, clicking confirm again should reuse the preserved state (e.g., `pendingMode`) and call the mutation with the same args. A regression that keeps the modal open but clears the pending state would pass a visibility-only test while leaving the user unable to retry.
