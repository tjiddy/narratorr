---
scope: [backend, services]
files: [src/server/services/download.service.ts]
issue: 63
date: 2026-03-24
---
When a spec says "operation X should proceed even if step Y fails (best-effort)", the try-catch must wrap the CALL to the step (e.g., `try { await this.cancel(...) } catch {}`), not just errors inside the step. `cancel()` has its own internal try-catch for adapter failures but can still throw from DB errors — the outer try-catch in `grab()` is needed to guarantee the "best-effort" semantics promised by the AC.
