---
scope: [scope/core]
files: [src/core/notifiers/script.ts, src/server/services/notifier.service.ts]
issue: 382
source: spec-review
date: 2026-03-15
---
Test plan said "Script failure logs error without crashing" but `ScriptNotifier` doesn't log — it returns `{ success, message }`. Logging happens in the caller (`NotifierService.notify()`). Root cause: `/elaborate` assumed the adapter logged errors directly without reading the actual return contract. When writing test assertions for adapters in `src/core/`, verify whether the adapter logs or returns — core adapters follow a "no logging, throw or return" convention per CLAUDE.md.
