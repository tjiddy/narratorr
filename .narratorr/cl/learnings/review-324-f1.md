---
scope: [backend]
files: [src/server/jobs/monitor.ts, src/server/jobs/monitor.test.ts]
issue: 324
source: review
date: 2026-04-03
---
When a try/catch wraps multiple side effects (DB write + SSE emit), testing only the SSE-throw branch leaves the DB-throw branch unproven. Both branches share the same catch block but exercise different failure modes — the DB failure prevents the SSE emit from ever running, which is a distinct behavior worth asserting (no `book_status_change` emitted). Mock `db.update` to succeed on the first call (download status) and reject on the second (book status) using `mockReturnValueOnce` chaining.
