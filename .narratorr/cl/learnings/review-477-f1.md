---
scope: [backend]
files: [src/server/jobs/index.test.ts]
issue: 477
source: review
date: 2026-04-11
---
When testing `db.run(sql`VACUUM`)`, asserting `toHaveBeenCalledTimes(1)` is insufficient — it doesn't prove the SQL argument is actually VACUUM. The drizzle `sql` tagged template produces an object with `queryChunks[0].value[0]` containing the SQL string. Always assert the argument content for `db.run` calls, not just invocation count.
