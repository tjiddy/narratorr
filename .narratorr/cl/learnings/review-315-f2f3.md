---
scope: [backend, services]
files: [src/server/services/download-orchestrator.ts, src/server/services/download-orchestrator.test.ts]
issue: 315
source: review
date: 2026-04-03
---
Reviewer caught that the blacklist-failure and no-identifier-skip branches tested that blacklist was skipped/logged, but didn't prove that downstream side effects (revertBookStatus, SSE events) still ran. A test that only asserts return value and logging would pass even if the method returned early after the catch/skip. Lesson: for best-effort fire-and-forget branches, always assert that the *continuation* side effects still execute — not just that the skipped step was handled correctly.
