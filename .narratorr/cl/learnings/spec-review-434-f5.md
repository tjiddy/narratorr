---
scope: [scope/backend, scope/services]
files: [src/server/services/download.service.ts]
issue: 434
source: spec-review
date: 2026-03-18
---
Spec test plan said `updateProgress(1.0)` should NOT change status and unchanged progress should emit no SSE. The actual code sets status='completed' when progress>=1 and emits download_progress on every call regardless of change. The elaboration wrote aspirational behavior instead of current behavior. For refactoring specs, every test plan bullet must be verifiable against the current codebase.
