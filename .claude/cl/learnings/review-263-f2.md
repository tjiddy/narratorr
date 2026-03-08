---
scope: [scope/backend]
files: [src/server/services/indexer.service.test.ts]
issue: 263
source: review
date: 2026-03-08
---
Reviewer caught no-op placeholder tests (empty test bodies with comments saying "verified in route tests") that inflate test counts without providing actual coverage. These give false confidence — they appear in test suite output as passing but assert nothing.

Prevention: Never write empty test bodies as placeholders. Either write the real assertion or don't create the test case at all. If a behavior is tested elsewhere, it doesn't need a placeholder in the current file.
