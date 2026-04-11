---
scope: [backend]
files: [src/server/__tests__/helpers.ts, src/server/jobs/index.test.ts]
issue: 477
date: 2026-04-11
---
`createMockDb()` provides `select/insert/update/delete/transaction` but NOT `db.run()`. The housekeeping callback uses `db.run(sql\`VACUUM\`)` which requires manually adding `(db as Record<string, unknown>).run = vi.fn()` in tests. This is because `db.run()` is a lower-level libSQL method not part of the Drizzle query builder API that the mock covers.
