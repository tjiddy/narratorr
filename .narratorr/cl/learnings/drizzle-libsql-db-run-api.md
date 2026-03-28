---
scope: [backend, db]
files: [src/server/routes/health-routes.ts]
issue: 279
date: 2026-03-10
---
Drizzle's libsql driver only exposes `db.run(sql`...`)` on the database object — `.get()` and `.all()` are on prepared statements only. `db.run()` returns a `ResultSet` with `.rows` (array of arrays), not objects. Access values positionally: `result.rows[0][0]`.
