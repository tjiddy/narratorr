---
scope: [backend]
files: [src/server/services/quality-gate-orchestrator.test.ts]
issue: 358
date: 2026-04-05
---
Test fixtures defined as `const` at describe scope (e.g., `const downloadingBook = {...}`) are shared by reference across tests. If production code mutates the object (e.g., `book.status = 'importing'`), subsequent tests see the mutated value. Always use `{ ...fixture }` spread when passing fixtures to methods that may mutate them. This caused a subtle test failure where the second test saw `old_status: 'importing'` instead of `'downloading'`.