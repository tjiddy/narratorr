---
scope: [frontend]
files: [src/client/hooks/useBulkOperation.ts, src/client/hooks/useBulkOperation.test.ts]
issue: 143
source: review
date: 2026-03-26
---
Object.freeze() on a shared constant is a defensive coding change with an observable contract: the hook exposes a frozen progress object in idle state. The spec review correctly rejected `Object.isFrozen(IDLE_PROGRESS)` (private symbol), but the correct test is `Object.isFrozen(result.current.progress)` — the returned hook value. Without this, deleting Object.freeze leaves tests green. Root cause: the self-review and coverage subagents accepted "no behavioral change = no test needed" reasoning, but freeze IS testable via the hook's public return value.
