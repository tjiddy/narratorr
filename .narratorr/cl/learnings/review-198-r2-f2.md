---
scope: [backend]
files: [src/server/services/import.service.test.ts]
issue: 198
source: review
date: 2026-03-12
---
When testing DB operation ordering in import pipeline, `db.update` is called for multiple tables (books and downloads). Using `db.update.mockReturnValue` with a single chain captures ALL update calls. To distinguish, use `db.update.mockImplementation((table) => table === downloads ? trackedChain : defaultChain)` to only intercept the specific table's updates. This is critical when two tables have `.set({ status: 'imported' })` at different pipeline stages.
