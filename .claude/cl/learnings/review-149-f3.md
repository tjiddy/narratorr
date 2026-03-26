---
scope: [backend, services]
files: [src/server/services/merge.service.ts, src/server/services/merge.service.test.ts]
issue: 149
source: review
date: 2026-03-26
---
The DB timing test asserted that `db.update().set()` received the correct `size` value, but not that `stat()` was called on the post-rename destination path (as opposed to the staging path or any other path). Since both paths return the same mocked size, the test passed for either. When testing "value X comes from function Y called with argument Z," always assert the argument too — `expect(stat).toHaveBeenCalledWith(expectedOutputPath)` — not just the downstream result.
