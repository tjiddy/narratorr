---
scope: [backend, db]
files: [src/db/schema.ts, src/server/services/quality-gate-orchestrator.ts]
issue: 299
date: 2026-04-02
---
When adding a "revisit later" pattern, a dedicated marker column is essential — don't reuse generic fields (like `outputPath IS NOT NULL` or `status`) as selectors. Multiple unrelated code paths can leave those fields in the same state. A dedicated `pendingCleanup` timestamp prevents false positives from other failure paths (cancel, monitor missing-item, import failure). This was caught during spec review and saved significant implementation rework.
