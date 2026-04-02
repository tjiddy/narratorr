---
scope: [core, backend]
files: [src/core/indexers/myanonamouse.ts, src/core/indexers/myanonamouse.test.ts]
issue: 291
date: 2026-04-02
---
Making MAMConfig fields non-optional (required) causes blast radius across all test files that instantiate MyAnonamouseIndexer. The beforeEach fixture and every inline `new MyAnonamouseIndexer({...})` must include the new fields. This affected 5 locations in myanonamouse.test.ts. When adding required fields to adapter configs, enumerate all constructor call sites in tests first.
