---
scope: [scope/backend]
files: [apps/narratorr/src/server/services/rename.service.ts]
issue: 201
source: review
date: 2026-02-23
---
When a multi-step filesystem operation (folder move → file rename) updates a DB record, update the DB immediately after the first irreversible step — not at the end. If the second step fails, the DB path is already correct (files exist at the new location). The original code moved the folder, renamed files, THEN updated the DB path — meaning a file rename failure left the DB pointing at the old (now empty) location.
