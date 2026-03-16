---
scope: [scope/backend, scope/db]
files: [src/db/client.ts, src/server/config.ts]
issue: 280
source: spec-review
date: 2026-03-10
---
Spec described backing up a live SQLite database by raw file copy/zip, which can produce corrupt backups if transactions are in-flight. SQLite's official guidance recommends `VACUUM INTO` or the backup API for live databases. The elaboration and first spec-review response both missed this because they focused on file I/O patterns (EBUSY handling) rather than questioning whether a raw copy is fundamentally safe for SQLite. Any spec involving SQLite file operations should verify the concurrency safety of the chosen mechanism against SQLite documentation.
