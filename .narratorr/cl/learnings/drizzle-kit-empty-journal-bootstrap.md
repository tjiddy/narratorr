---
scope: [db]
files: [drizzle/meta/_journal.json]
issue: 596
date: 2026-04-15
---
`drizzle-kit generate` requires `drizzle/meta/_journal.json` to exist before running — deleting it and running generate fails with ENOENT. When flattening migrations, seed an empty journal (`{"version":"7","dialect":"sqlite","entries":[]}`) before regenerating.
