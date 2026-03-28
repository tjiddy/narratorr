---
scope: [backend, frontend]
files: [src/shared/download-status-registry.ts, src/server/services/download.service.ts]
issue: 83
date: 2026-03-25
---
When renaming an exported function, start the red/green cycle by updating the consumer (import + call sites) to the new name first, BEFORE renaming the actual export. This guarantees the test run fails (red) because the import resolves to `undefined`. Renaming the export first would make the tests pass immediately, skipping the red phase and making the TDD cycle vacuous.
