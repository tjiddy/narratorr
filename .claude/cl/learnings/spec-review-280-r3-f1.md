---
scope: [scope/backend, scope/db]
files: [src/server/index.ts, src/db/client.ts]
issue: 280
source: spec-review
date: 2026-03-10
---
Spec described replacing the DB file at `config.dbPath` while the current process still held a long-lived libSQL client open to it (created at startup, used for the process lifetime). This was caught in round 3 after rounds 1 and 2 addressed other issues. The root cause: the spec treated "copy file then exit" as atomic, but file replacement while a handle is open is unsafe on some platforms and undefined on all. The fix was a startup swap pattern — stage the file, exit, and swap on next boot before opening the DB. Any spec involving file replacement of actively-opened resources must define the handle lifecycle and ensure replacement happens only when no process has the file open.
