---
scope: [backend, services]
files: [src/server/services/import-queue-worker.ts]
issue: 674
date: 2026-04-22
---
When a boot-time sweep touches multiple related rows (e.g., `import_jobs` + `books`), wrap EACH iteration's writes in its own `db.transaction()`, not the whole sweep. A sweep-wide transaction causes one bad row to abort recovery for every other orphan — the opposite of "continue-on-error." Per-iteration transactions give atomicity within an orphan (both tables rollback together) while isolating failures between orphans. Catch at the loop body, log with `serializeError()` + ids, and emit a summary log (`count`, `recovered`, `failed`) after the sweep so partial recovery is visible without grepping per-line output. Do NOT catch the initial SELECT that loads the work set — a catastrophic DB failure there should propagate to `start()`.
